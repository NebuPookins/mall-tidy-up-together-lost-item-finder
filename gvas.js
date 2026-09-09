// Minimal in-browser GVAS reader for "Mall: Tidy Up Together" (UE 4.25, package 518).
// Parses the binary save format into a {header, props} tree. Exposes `parseGvas`
// on `window`. No dependencies; runs in any modern browser.
(function (global) {
  'use strict';

  var td = new TextDecoder();

  function Reader(bytes) {
    this.b = bytes; // Uint8Array
    this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.o = 0;
  }
  Reader.prototype.u8 = function () { var v = this.v.getUint8(this.o); this.o += 1; return v; };
  Reader.prototype.u16 = function () { var v = this.v.getUint16(this.o, true); this.o += 2; return v; };
  Reader.prototype.i16 = function () { var v = this.v.getInt16(this.o, true); this.o += 2; return v; };
  Reader.prototype.u32 = function () { var v = this.v.getUint32(this.o, true); this.o += 4; return v; };
  Reader.prototype.i32 = function () { var v = this.v.getInt32(this.o, true); this.o += 4; return v; };
  Reader.prototype.i64 = function () { var v = this.v.getBigInt64(this.o, true); this.o += 8; return v; };
  Reader.prototype.f32 = function () { var v = this.v.getFloat32(this.o, true); this.o += 4; return v; };
  Reader.prototype.skip = function (n) { this.o += n; };
  Reader.prototype.bytes = function (n) { var s = this.b.subarray(this.o, this.o + n); this.o += n; return s; };
  Reader.prototype.str = function () {
    var len = this.u32();
    if (len < 1 || this.o + len > this.b.length) {
      throw new Error('Malformed string length ' + len + ' at byte ' + this.o);
    }
    var s = td.decode(this.b.subarray(this.o, this.o + len - 1));
    this.o += len;
    return s;
  };

  // GVAS file-end sentinel: "None\0" (5 bytes) + 4 zero bytes.
  var FILE_END = new Uint8Array([0x05, 0, 0, 0, 0x4E, 0x6F, 0x6E, 0x65, 0, 0, 0, 0, 0]);

  function parseHeader(r) {
    r.skip(4); // "GVAS"
    var saveGameVersion = r.i32();
    var packageVersion = r.i32();
    var ue5 = null;
    if (saveGameVersion >= 3) ue5 = r.i32();
    var major = r.i16(), minor = r.i16(), patch = r.i16();
    var changelist = r.u32();
    var branch = r.str();
    var customVersionFormat = r.i32();
    var numCustom = r.i32();
    for (var i = 0; i < numCustom; i++) { r.bytes(16); r.i32(); }
    var saveGameClassName = r.str();
    return {
      saveGameVersion: saveGameVersion,
      packageVersion: packageVersion,
      ue5: ue5,
      engine: major + '.' + minor + '.' + patch,
      changelist: changelist,
      branch: branch,
      customVersionFormat: customVersionFormat,
      numCustom: numCustom,
      saveGameClassName: saveGameClassName
    };
  }

  function parseStruct(r, name) {
    var contentSize = r.u32();
    r.skip(4); // padding
    var subtype = r.str();
    r.bytes(16); // guid
    r.skip(1);   // terminator
    var end = r.o + contentSize;
    var value;
    switch (subtype) {
      case 'Quat': value = { x: r.f32(), y: r.f32(), z: r.f32(), w: r.f32() }; break;
      case 'Vector': value = { x: r.f32(), y: r.f32(), z: r.f32() }; break;
      case 'Rotator': value = { pitch: r.f32(), yaw: r.f32(), roll: r.f32() }; break;
      case 'Vector2D': value = { x: r.f32(), y: r.f32() }; break;
      case 'Guid': value = r.bytes(16); break;
      case 'DateTime': value = r.i64(); break;
      case 'Timespan': value = r.i64(); break;
      case 'LinearColor': value = { r: r.f32(), g: r.f32(), b: r.f32(), a: r.f32() }; break;
      case 'IntPoint': value = { x: r.i32(), y: r.i32() }; break;
      default:
        value = [];
        while (r.o < end) value.push(parseProperty(r));
    }
    return { type: 'StructProperty', name: name, subtype: subtype, value: value };
  }

  function parseArray(r, name) {
    var contentSize = r.u32();
    r.skip(4); // padding
    var subtype = r.str();
    r.skip(1); // terminator
    var value, genericType = null;
    switch (subtype) {
      case 'StructProperty': {
        var count = r.u32();
        r.str();      // field name (== name)
        r.str();      // "StructProperty"
        r.u32(); r.skip(4); // arraySize (u64 = u32 + pad)
        genericType = r.str(); // struct type name
        r.bytes(16);  // guid
        r.skip(1);
        value = [];
        for (var i = 0; i < count; i++) {
          var el = [];
          var p;
          do { p = parseProperty(r); el.push(p); } while (p.type !== 'None');
          value.push(el);
        }
        break;
      }
      case 'NameProperty': {
        var n = r.u32();
        value = [];
        for (var j = 0; j < n; j++) value.push(r.str());
        break;
      }
      default:
        r.skip(contentSize); // primitive element arrays (Bool/Int/Byte/Float/Str/Enum...)
        value = null;
    }
    return { type: 'ArrayProperty', name: name, subtype: subtype, genericType: genericType, value: value };
  }

  function parseProperty(r) {
    var name = r.str();
    if (name === 'None') return { type: 'None', name: name };
    var type = r.str();
    switch (type) {
      case 'BoolProperty': { r.skip(8); var bv = r.u8() !== 0; var bh = r.u8() !== 0; if (bh) r.skip(16); return { type: type, name: name, value: bv }; }
      case 'IntProperty': { r.skip(8); var ih = r.u8() !== 0; if (ih) r.skip(16); return { type: type, name: name, value: r.i32() }; }
      case 'UInt32Property': { r.skip(8); var uh = r.u8() !== 0; if (uh) r.skip(16); return { type: type, name: name, value: r.u32() }; }
      case 'Int64Property': { r.skip(8); var lh = r.u8() !== 0; if (lh) r.skip(16); return { type: type, name: name, value: r.i64() }; }
      case 'StrProperty': { r.skip(8); var sh = r.u8() !== 0; if (sh) r.skip(16); return { type: type, name: name, value: r.str() }; }
      case 'NameProperty': { r.skip(9); return { type: type, name: name, value: r.str() }; }
      case 'FloatProperty': { r.skip(9); return { type: type, name: name, value: r.f32() }; }
      case 'EnumProperty': { r.u32(); r.skip(4); var en = r.str(); r.skip(1); return { type: type, name: name, enum: en, value: r.str() }; }
      // ByteProperty: enum-style stores its value as a string (FString), plain bytes as a single u8.
      case 'ByteProperty': {
        r.skip(8); // contentSize + arrayIndex
        var sub = r.str();
        var gh = r.u8() !== 0;
        if (gh) r.skip(16);
        var value = (sub === '') ? r.u8() : r.str();
        return { type: type, name: name, subtype: sub, value: value };
      }
      case 'StructProperty': return parseStruct(r, name);
      case 'ArrayProperty': return parseArray(r, name);
      case 'ObjectProperty': { r.u32(); r.skip(4); return { type: type, name: name, value: r.str() }; }
      case 'MapProperty': { r.u32(); r.skip(4); return { type: type, name: name, value: null }; }
      case 'SetProperty': { r.u32(); r.skip(4); return { type: type, name: name, value: null }; }
      case 'TextProperty': { r.u32(); r.skip(4); return { type: type, name: name, value: null }; }
      default: throw new Error('Unknown property type "' + type + '" at byte ' + r.o);
    }
  }

  function parseGvas(bytes) {
    if (!(bytes instanceof Uint8Array)) {
      bytes = new Uint8Array(bytes);
    }
    var r = new Reader(bytes);
    var header = parseHeader(r);
    var props = [];
    while (r.o < r.b.length) {
      if (r.b.length - r.o === FILE_END.length) {
        var tail = r.b.subarray(r.o);
        var isEnd = true;
        for (var i = 0; i < FILE_END.length; i++) { if (tail[i] !== FILE_END[i]) { isEnd = false; break; } }
        if (isEnd) break;
      }
      props.push(parseProperty(r));
    }
    return { header: header, props: props };
  }

  global.parseGvas = parseGvas;
})(typeof window !== 'undefined' ? window : globalThis);
