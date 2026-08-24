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

  function read(base64, fileName) {
    const files = storedZip(base64);
    if (!files["item.json"]) throw new Error("Tweegee Item is missing item.json");
    let item;
    try { item = JSON.parse(utf8(files["item.json"])); }
    catch (_) { throw new Error("Tweegee Item has an invalid item.json"); }
    if (item.version !== 1 || !Array.isArray(item.targets))
      throw new Error("unsupported Tweegee Item version");

    const project = {
      version: 3, name: `Tweegee Item ${item.itemId ?? fileName}`, fps: 24,
      assets: [], bones: [], slots: [], draw_order: [], skins: [{ name: "default", entries: [] }],
      default_skin: "default", constraints: [], constraint_order: [], animations: [],
    };
    const images = {}, bones = new Set();
    function ensureBone(name) {
      if (!name || bones.has(name)) return;
      const split = name.lastIndexOf(".");
      const parent = split < 0 ? "" : name.slice(0, split);
      ensureBone(parent);
      project.bones.push({ name, parent, length: 0, tx: 0, ty: 0, rotation: 0,
        sx: 1, sy: 1, shear_x: 0, shear_y: 0,
        inherit_rotation: true, inherit_scale: true, inherit_reflect: true });
      bones.add(name);
    }

    for (const target of item.targets) {
      ensureBone(String(target.bone || target.name));
      const placed = transform(target.transform);
      for (let index = 0; index < (target.layers || []).length; index++) {
        const layer = target.layers[index];
        const path = `images/${layer.file}`;
        const bytes = files[path];
        if (!bytes) throw new Error(`Tweegee Item is missing ${path}`);
        const assetName = `${target.name}.${index}`;
        const scale = Number(item.assetScale || 1);
        const pixelWidth = Number(layer.width || 0);
        const pixelHeight = Number(layer.height || 0);
        const width = pixelWidth / scale;
        const height = pixelHeight / scale;
        project.assets.push({ name: assetName, file: layer.file,
          width: pixelWidth, height: pixelHeight });
        images[assetName] = encode64(bytes);
        const slot = `${target.name}.${index}`;
        project.slots.push({ name: slot, bone: target.bone, attachment: assetName,
          color: [1, 1, 1, 1], dark_color: null, blend_mode: "normal" });
        project.draw_order.push(slot);
        project.skins[0].entries.push({ slot, name: assetName, attachment: {
          type: "region", texture: assetName,
          offset_x: placed.x, offset_y: placed.y, rotation: placed.rotation,
          scale_x: placed.scaleX, scale_y: placed.scaleY,
          width, height, uv: [0, 0, 1, 1],
          pivot_x: Number(layer.pivotX ?? 0.5), pivot_y: Number(layer.pivotY ?? 0.5),
        }});
      }
    }
    const report = { dangling: [], lossy: [] };
    if (item.targets.some((target) => (target.layers || []).some((layer) => layer.kind === "fill")))
      report.lossy.push({ what: "item fill", where: String(item.itemId ?? fileName),
        detail: "fill indices are imported as ordinary image layers" });
    ankhimate.importProject(project, images, report);
  }

  ankhimate.registerImporter({
    id: "import.twitem", label: "Tweegee Item", extensions: ["twitem"], binary: true,
    canRead(base64) { return base64.startsWith("UEsDB"); },
    read,
  });
})();
