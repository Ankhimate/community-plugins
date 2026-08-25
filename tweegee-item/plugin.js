// Tweegee Item community plugin for Ankhimate.
// Reads binary TWIT metadata and its external atlas pages.
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
    catch (_) { throw new Error("Tweegee Item contains invalid UTF-8"); }
  };

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = (crc ^ byte) >>> 0;
      for (let bit = 0; bit < 8; bit++)
        crc = ((crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)) >>> 0;
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function messagePack(bytes) {
    let at = 0;
    const take = () => {
      if (at >= bytes.length) throw new Error("Tweegee Item has truncated MessagePack");
      return bytes[at++];
    };
    const uint = (count) => {
      let value = 0;
      for (let i = 0; i < count; i++) value = value * 256 + take();
      return value;
    };
    const string = (length) => {
      if (at + length > bytes.length) throw new Error("Tweegee Item has truncated MessagePack");
      const value = utf8(bytes.slice(at, at + length));
      at += length;
      return value;
    };
    const array = (length) => Array.from({length}, () => read());
    const map = (length) => {
      const value = {};
      for (let i = 0; i < length; i++) value[String(read())] = read();
      return value;
    };
    const float64 = () => {
      const buffer = new ArrayBuffer(8), view = new DataView(buffer);
      for (let i = 0; i < 8; i++) view.setUint8(i, take());
      return view.getFloat64(0, false);
    };
    function read() {
      const tag = take();
      if (tag <= 0x7f) return tag;
      if (tag >= 0xe0) return tag - 256;
      if ((tag & 0xe0) === 0xa0) return string(tag & 31);
      if ((tag & 0xf0) === 0x90) return array(tag & 15);
      if ((tag & 0xf0) === 0x80) return map(tag & 15);
      if (tag === 0xc0) return null;
      if (tag === 0xc2 || tag === 0xc3) return tag === 0xc3;
      if (tag === 0xcc) return uint(1);
      if (tag === 0xcd) return uint(2);
      if (tag === 0xce) return uint(4);
      if (tag === 0xd2) { const n = uint(4); return n > 0x7fffffff ? n - 0x100000000 : n; }
      if (tag === 0xcb) return float64();
      if (tag === 0xd9) return string(uint(1));
      if (tag === 0xda) return string(uint(2));
      if (tag === 0xdc) return array(uint(2));
      if (tag === 0xde) return map(uint(2));
      throw new Error(`Tweegee Item uses unsupported MessagePack tag 0x${tag.toString(16)}`);
    }
    const value = read();
    if (at !== bytes.length) throw new Error("Tweegee Item has trailing MessagePack data");
    return value;
  }

  function twit(base64) {
    const file = decode64(base64);
    if (file.length < 16 || utf8(file.slice(0, 4)) !== "TWIT")
      throw new Error("not a binary Tweegee Item");
    if (u16(file, 4) !== 1) throw new Error(`unsupported Tweegee Item version ${u16(file, 4)}`);
    if (file[6] !== 1) throw new Error(`unsupported Tweegee Item codec ${file[6]}`);
    if (file[7] & ~1) throw new Error(`unsupported Tweegee Item flags ${file[7]}`);
    let payload = file.slice(16);
    if (file[7] & 1) payload = decode64(ankhimate.inflateRaw(encode64(payload)));
    if (payload.length !== u32(file, 8)) throw new Error("Tweegee Item payload length mismatch");
    if (crc32(payload) !== u32(file, 12)) throw new Error("Tweegee Item checksum mismatch");
    return messagePack(payload);
  }

  function transform(matrix) {
    const m = Array.isArray(matrix) ? {
      a: matrix[0], b: matrix[1], c: matrix[2], d: matrix[3], tx: matrix[4], ty: matrix[5],
    } : (matrix || {});
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

  function startsAt(bone, name) {
    return bone === name || bone.startsWith(`${name}.`);
  }

  function facingMembership(bone) {
    if (!bone) return null;
    if (startsAt(bone, "avatar_head.face")) return "Front";
    // Hair and head equipment remain visible; Flash changes their depth.
    if (bone.endsWith("hair_front") || bone.endsWith("hair_back")
      || startsAt(bone, "avatar_head.item_front")
      || startsAt(bone, "avatar_head.item_back")
      || startsAt(bone, "avatar_back.item_head_back")) return "Both";
    // This asymmetric legacy membership is intentional: Avatar.frontElements
    // and Avatar.backElements both contain the rear container's left-front
    // holder, while its left-back holder belongs to neither list.
    if (startsAt(bone, "avatar_back.item_left_front")) return "Both";
    if (startsAt(bone, "avatar_back.item_left_back")) return null;
    const segment = bone.slice(bone.lastIndexOf(".") + 1);
    if (segment === "clothing_front" || segment === "item_front"
      || segment.endsWith("_front")) return "Front";
    if (segment === "clothing_back" || segment === "item_back"
      || segment.endsWith("_back")) return "Back";
    return null;
  }

  function facingDrawOrder(facing, skeleton) {
    const slotByName = new Map(skeleton.slots.map((slot) => [slot.name, slot]));
    const base = skeleton.draw_order.slice();
    const isGroup = (name, group) => startsAt(slotByName.get(name)?.bone || "", group);
    const rear = base.filter((name) => isGroup(name, "avatar_back"));
    const front = base.filter((name) => isGroup(name, "avatar_front"));
    let middle = base.filter((name) => !isGroup(name, "avatar_back") && !isGroup(name, "avatar_front"));

    // Flash moves head.item_front to the top/bottom of the head container.
    const headItem = middle.filter((name) => isGroup(name, "avatar_head.item_front"));
    middle = middle.filter((name) => !isGroup(name, "avatar_head.item_front"));
    const headIndices = middle
      .map((name, index) => isGroup(name, "avatar_head") ? index : -1)
      .filter((index) => index >= 0);
    if (headItem.length && headIndices.length) {
      const insertAt = facing === "Front"
        ? headIndices[headIndices.length - 1] + 1
        : headIndices[0];
      middle.splice(insertAt, 0, ...headItem);
    } else {
      middle.push(...headItem);
    }
    return facing === "Front"
      ? [...rear, ...middle, ...front]
      : [...front, ...middle, ...rear];
  }

  // Reproduce Avatar.updateVisible as transient editor state: visibility,
  // top-level depth, head-item depth, and the dummy's horizontal reflection.
  function facingEffect(facing) {
    const slot_visibility = {};
    const skeleton = rig().skeleton;
    for (const slot of skeleton.slots) {
      if (slot.name.startsWith("twitem.hair.")) {
        slot_visibility[slot.name] = true;
        continue;
      }
      const membership = facingMembership(slot.bone);
      if (membership) slot_visibility[slot.name] = membership === "Both" || membership === facing;
    }
    const root = skeleton.bones.find((bone) => bone.name === "root" && !bone.parent)
      || skeleton.bones.find((bone) => !bone.parent);
    const bone_scale_x = {};
    if (root) bone_scale_x[root.name] = Math.abs(Number(root.sx || 1)) * (facing === "Front" ? 1 : -1);
    return { slot_visibility, bone_scale_x, draw_order: facingDrawOrder(facing, skeleton) };
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

  function importItem(file) {
    const packed = twit(file.bytes_base64);
    const item = {
      version: packed.v, itemId: packed.i, category: packed.c, section: packed.s,
      assetScale: packed.z, pages: packed.p || [], targets: (packed.t || []).map((target) => ({
        name: target.n, bone: target.b, transform: target.m,
        layers: (target.l || []).map((layer) => ({
          kind: layer.k === 1 ? "fill" : "merged", page: layer.q,
          x: layer.x, y: layer.y, width: layer.w, height: layer.h,
          source: layer.d, offset: layer.o, pivot: layer.r,
          fillIndex: layer.f, parentCategory: layer.pc, parentRequired: layer.pr,
        })),
      })),
    };
    if (item.version !== 1 || !Array.isArray(item.targets))
      throw new Error("unsupported Tweegee Item version");

    const before = names();
    const bones = new Set(before.bones), slots = new Set(before.slots), images = new Set(before.images);
    const section = clean(item.section || "items"), itemId = clean(item.itemId ?? file.name);
    const attachment = attachmentName(itemId);
    const pages = item.pages.map((page, index) => {
      const encoded = (file.assets || {})[String(page.f || "")];
      if (!encoded) throw new Error(`Tweegee Item is missing atlas page ${page.f || index}`);
      const info = ankhimate.imageInfo(encoded);
      if (info.width !== Number(page.w) || info.height !== Number(page.h))
        throw new Error(`Tweegee Item atlas page ${page.f} dimensions do not match metadata`);
      return encoded;
    });

    for (const target of item.targets) {
      const bone = String(target.bone || target.name);
      if (!bones.has(bone)) throw new Error(`Tweegee Item target bone \`${bone}\` is not in this avatar`);
      const placed = transform(target.transform);
      for (let index = 0; index < (target.layers || []).length; index++) {
        const layer = target.layers[index];
        const atlas = pages[Number(layer.page)];
        if (!atlas) throw new Error(`Tweegee Item references missing atlas page ${layer.page}`);
        const bytes = ankhimate.cropImage(atlas, {
          x: Number(layer.x), y: Number(layer.y),
          width: Number(layer.width), height: Number(layer.height),
        });
        const assetName = `twitem.${itemId}.${clean(target.name)}.${index}`;
        const scale = Number(item.assetScale || 1);
        const source = Array.isArray(layer.source) ? layer.source : [layer.width, layer.height];
        const pixelWidth = Number(source[0] || 0);
        const pixelHeight = Number(source[1] || 0);
        const width = pixelWidth / scale;
        const height = pixelHeight / scale;
        if (!images.has(assetName)) {
          ops.invoke("asset.add_image", { name: assetName, bytes_base64: bytes });
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
          pivot_x: Number(layer.pivot?.[0] ?? 0.5), pivot_y: Number(layer.pivot?.[1] ?? 0.5),
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
        { file: "Import .twitem", on: "import", extensions: ["twitem"], multiple: true,
          assets: true },
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
        for (const file of value || []) importItem(file);
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
