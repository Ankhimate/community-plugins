// Tweegee Item community plugin for Ankhimate.
// Reads the ZIP-based .twitem format produced by tweegee-exporter.
(function () {
  "use strict";

  function decode64(text) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const out = [];
    let buffer = 0, bits = 0;
    for (const char of text.replace(/\s/g, "")) {
      if (char === "=") break;
      const value = alphabet.indexOf(char);
      if (value < 0) throw new Error("Tweegee Item contains invalid base64");
      buffer = buffer * 64 + value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out.push(Math.floor(buffer / (2 ** bits)) & 255);
        buffer %= 2 ** bits;
      }
    }
    return out;
  }

  function encode64(bytes) {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const remaining = bytes.length - i;
      const value = bytes[i] * 65536 + (bytes[i + 1] || 0) * 256 + (bytes[i + 2] || 0);
      out += alphabet[(value >> 18) & 63] + alphabet[(value >> 12) & 63];
      out += remaining > 1 ? alphabet[(value >> 6) & 63] : "=";
      out += remaining > 2 ? alphabet[value & 63] : "=";
    }
    return out;
  }

  const u16 = (b, p) => b[p] + b[p + 1] * 256;
  const u32 = (b, p) => u16(b, p) + u16(b, p + 2) * 65536;
  const utf8 = (bytes) => {
    let escaped = "";
    for (const byte of bytes) escaped += `%${byte.toString(16).padStart(2, "0")}`;
    try { return decodeURIComponent(escaped); }
    catch (_) { throw new Error("Tweegee Item has an invalid UTF-8 entry name or manifest"); }
  };

  function storedZip(base64) {
    const bytes = decode64(base64), files = {};
    let offset = 0;
    while (offset + 30 <= bytes.length && u32(bytes, offset) === 0x04034b50) {
      const method = u16(bytes, offset + 8);
      const size = u32(bytes, offset + 18);
      const nameLength = u16(bytes, offset + 26);
      const extraLength = u16(bytes, offset + 28);
      if (method !== 0) throw new Error("Tweegee Item uses unsupported ZIP compression");
      const nameStart = offset + 30;
      const dataStart = nameStart + nameLength + extraLength;
      const dataEnd = dataStart + size;
      if (dataEnd > bytes.length) throw new Error("Tweegee Item has a truncated ZIP entry");
      files[utf8(bytes.slice(nameStart, nameStart + nameLength))] = bytes.slice(dataStart, dataEnd);
      offset = dataEnd;
    }
    return files;
  }

  function transform(matrix) {
    const m = matrix || {};
    const a = Number(m.a ?? 1), b = Number(m.b ?? 0);
    const c = Number(m.c ?? 0), d = Number(m.d ?? 1);
    const sx = Math.hypot(a, b) || 1;
    const determinant = a * d - b * c;
    return {
      x: Number(m.tx ?? 0), y: Number(m.ty ?? 0),
      rotation: Math.atan2(b, a) * 180 / Math.PI,
      scaleX: sx, scaleY: determinant / sx,
    };
  }

  const clean = (value) => String(value).replace(/[^A-Za-z0-9_.-]/g, "_");
  const slotPrefix = (section) => `twitem.${clean(section)}.`;
  const attachmentName = (itemId) => `twitem.${clean(itemId)}`;

  function equipmentSlots() {
    const skeleton = rig().skeleton;
    const bones = new Map(skeleton.slots.map((slot) => [slot.name, slot]));
    return names().attachments
      .filter((slot) => slot.slot.startsWith("twitem."))
      .map((slot) => ({ ...slot, bone: bones.get(slot.slot)?.bone, color: bones.get(slot.slot)?.color }));
  }

  function facingVariant(bone) {
    if (!bone) return null;
    if (bone.endsWith("_front") || bone.endsWith(".front")) return "Front";
    if (bone.endsWith("_back") || bone.endsWith(".back")) return "Back";
    return null;
  }

  // Flash's `frontFacing` kept both variants loaded and toggled `.visible`.
  // Return the same transient view change to the host: no rig edit, no keys,
  // and therefore safe while an animation is playing.
  function facingEffect(facing) {
    const slot_visibility = {};
    for (const slot of equipmentSlots()) {
      // Hair's front/back names are depth layers around the head, not facing
      // variants. Flash kept both containers visible and synchronized the rear
      // one to the animated head marker.
      const section = slot.slot.split(".")[1];
      if (section === "hair") {
        slot_visibility[slot.slot] = true;
        continue;
      }
      const variant = facingVariant(slot.bone);
      slot_visibility[slot.slot] = !variant || variant === facing;
    }
    return { slot_visibility };
  }

  // The animation exporter leaves one empty slot at every Flash depth where
  // equipment may draw. Item layers need to sit beside that anchor; creating
  // slots normally appends them, which puts even `*_back` art over the entire
  // avatar. Rebuild the order around the animation's non-item anchors while
  // preserving layer creation order within each target.
  function placeEquipmentAtAnchors() {
    const skeleton = rig().skeleton;
    const equipment = skeleton.slots.filter((slot) => slot.name.startsWith("twitem."));
    if (!equipment.length) return;

    const byBone = new Map();
    for (const slot of equipment) {
      if (!byBone.has(slot.bone)) byBone.set(slot.bone, []);
      byBone.get(slot.bone).push(slot.name);
    }

    const slotByName = new Map(skeleton.slots.map((slot) => [slot.name, slot]));
    const anchorIndex = new Map();
    skeleton.draw_order.forEach((name, index) => {
      if (!name.startsWith("twitem.")) {
        const bone = slotByName.get(name)?.bone;
        if (bone && !anchorIndex.has(bone)) anchorIndex.set(bone, index);
      }
    });
    const frontForBack = (bone) => bone.endsWith("_back")
      ? `${bone.slice(0, -5)}_front`
      : bone.endsWith(".back") ? `${bone.slice(0, -5)}.front` : null;
    const backForFront = (bone) => bone.endsWith("_front")
      ? `${bone.slice(0, -6)}_back`
      : bone.endsWith(".front") ? `${bone.slice(0, -6)}.back` : null;
    const order = [];
    const placedBones = new Set();
    for (const name of skeleton.draw_order) {
      if (name.startsWith("twitem.")) continue;
      order.push(name);
      const bone = slotByName.get(name)?.bone;
      if (bone && byBone.has(bone) && !placedBones.has(bone)) {
        const back = backForFront(bone);
        if (back && byBone.has(back)
          && anchorIndex.get(bone) < anchorIndex.get(back)) continue;
        order.push(...byBone.get(bone));
        placedBones.add(bone);
        const front = frontForBack(bone);
        if (front && byBone.has(front)
          && anchorIndex.get(front) < anchorIndex.get(bone)) {
          order.push(...byBone.get(front));
          placedBones.add(front);
        }
      }
    }
    for (const slot of equipment) {
      if (!placedBones.has(slot.bone)) order.push(slot.name);
    }
    ops.invoke("slot.set_draw_order", { slots: order });
  }

  function importItem(base64, fileName) {
    const files = storedZip(base64);
    if (!files["item.json"]) throw new Error("Tweegee Item is missing item.json");
    let item;
    try { item = JSON.parse(utf8(files["item.json"])); }
    catch (_) { throw new Error("Tweegee Item has an invalid item.json"); }
    if (item.version !== 1 || !Array.isArray(item.targets))
      throw new Error("unsupported Tweegee Item version");

    const before = names();
    const bones = new Set(before.bones), slots = new Set(before.slots), images = new Set(before.images);
    const section = clean(item.section || "items"), itemId = clean(item.itemId ?? fileName);
    const attachment = attachmentName(itemId);

    for (const target of item.targets) {
      const bone = String(target.bone || target.name);
      if (!bones.has(bone)) throw new Error(`Tweegee Item target bone \`${bone}\` is not in this avatar`);
      const placed = transform(target.transform);
      for (let index = 0; index < (target.layers || []).length; index++) {
        const layer = target.layers[index];
        const path = `images/${layer.file}`;
        const bytes = files[path];
        if (!bytes) throw new Error(`Tweegee Item is missing ${path}`);
        const assetName = `twitem.${itemId}.${clean(target.name)}.${index}`;
        const scale = Number(item.assetScale || 1);
        const pixelWidth = Number(layer.width || 0);
        const pixelHeight = Number(layer.height || 0);
        const width = pixelWidth / scale;
        const height = pixelHeight / scale;
        if (!images.has(assetName)) {
          ops.invoke("asset.add_image", { name: assetName, bytes_base64: encode64(bytes) });
          images.add(assetName);
        }
        const slot = `${slotPrefix(section)}${clean(target.name)}.${index}`;
        if (!slots.has(slot)) {
          ops.invoke("slot.create", { name: slot, bone });
          slots.add(slot);
        }
        ops.invoke("attachment.create_region", {
          slot, name: attachment, texture: assetName,
          x: placed.x, y: placed.y, rotation: placed.rotation,
          scale_x: placed.scaleX, scale_y: placed.scaleY,
          width, height,
          pivot_x: Number(layer.pivotX ?? 0.5), pivot_y: Number(layer.pivotY ?? 0.5),
          show: false,
        });
      }
    }
    if (item.targets.some((target) => (target.layers || []).some((layer) => layer.kind === "fill")))
      ops.invoke("import.report", { what: "item fill", where: itemId,
        detail: "fill indices are imported as ordinary image layers" });
    placeEquipmentAtAnchors();
    equip(section, itemId, false);
  }

  function inventory() {
    const result = {};
    for (const slot of names().attachments) {
      if (!slot.slot.startsWith("twitem.")) continue;
      const parts = slot.slot.split(".");
      const section = parts[1];
      for (const available of slot.available) {
        if (!available.startsWith("twitem.")) continue;
        const id = available.slice(7);
        const key = `${section}:${id}`;
        if (!result[key]) result[key] = { section, id, equipped: false };
        if (slot.current === available) result[key].equipped = true;
      }
    }
    return Object.values(result).sort((a, b) =>
      a.section.localeCompare(b.section) || a.id.localeCompare(b.id));
  }

  function equip(section, itemId, toggle = true) {
    const wanted = attachmentName(itemId);
    const relevant = names().attachments.filter((slot) => slot.slot.startsWith(slotPrefix(section)));
    const already = relevant.some((slot) => slot.current === wanted);
    const show = toggle ? !already : true;
    for (const slot of relevant) {
      const available = slot.available.includes(wanted);
      ops.invoke("slot.set_attachment", {
        slot: slot.slot, attachment: show && available ? wanted : null,
      });
    }
  }

  ankhimate.registerPanel({
    id: "tweegee.items", title: "Tweegee Items",
    build() {
      const widgets = [
        { heading: "Equipment" },
        { choice: "Facing", on: "facing", options: ["Front", "Back"], value: "Front",
          tooltip: "Show the item's front-facing or back-facing layers." },
        { file: "Import .twitem", on: "import", extensions: ["twitem"], multiple: true },
      ];
      for (const item of inventory()) widgets.push({
        button: `${item.equipped ? "✓ " : ""}${item.section}: ${item.id}`,
        on: `toggle:${item.section}:${item.id}`,
      });
      if (widgets.length === 2) widgets.push({ text: "No items imported.", weak: true });
      return widgets;
    },
    on(action, value, state) {
      if (action === "facing") {
        return facingEffect(value === "Back" ? "Back" : "Front");
      }
      if (action === "import") {
        for (const file of value || []) importItem(file.bytes_base64, file.name);
        return facingEffect(state.facing === "Back" ? "Back" : "Front");
      }
      if (action.startsWith("toggle:")) {
        const [, section, id] = action.split(":");
        equip(section, id);
        return facingEffect(state.facing === "Back" ? "Back" : "Front");
      }
    },
  });
})();
