var MarkdownReviewPng = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // web/src/png-decoder.mjs
  var png_decoder_exports = {};
  __export(png_decoder_exports, {
    decodePng: () => decodePng2
  });

  // node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start) {
    var b = new u16(31);
    for (var i2 = 0; i2 < 31; ++i2) {
      b[i2] = start += 1 << eb[i2 - 1];
    }
    var r = new i32(b[30]);
    for (var i2 = 1; i2 < 30; ++i2) {
      for (var j = b[i2]; j < b[i2 + 1]; ++j) {
        r[j] = j - b[i2] << 5 | i2;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = (function(cd, mb, r) {
    var s = cd.length;
    var i2 = 0;
    var l = new u16(mb);
    for (; i2 < s; ++i2) {
      if (cd[i2])
        ++l[cd[i2] - 1];
    }
    var le = new u16(mb);
    for (i2 = 1; i2 < mb; ++i2) {
      le[i2] = le[i2 - 1] + l[i2 - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i2 = 0; i2 < s; ++i2) {
        if (cd[i2]) {
          var sv = i2 << 4 | cd[i2];
          var r_1 = mb - cd[i2];
          var v = le[cd[i2] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i2 = 0; i2 < s; ++i2) {
        if (cd[i2]) {
          co[i2] = rev[le[cd[i2] - 1]++] >> 15 - cd[i2];
        }
      }
    }
    return co;
  });
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
  var max = function(a) {
    var m = a[0];
    for (var i2 = 1; i2 < a.length; ++i2) {
      if (a[i2] > m)
        m = a[i2];
    }
    return m;
  };
  var bits = function(d, p, m) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
  };
  var bits16 = function(d, p) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  };
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    // determined by compression function
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var inflt = function(dat, st, buf, dict) {
    var sl = dat.length, dl = dict ? dict.length : 0;
    if (!sl || st.f && !st.l)
      return buf || new u8(0);
    var noBuf = !buf;
    var resize = noBuf || st.i != 2;
    var noSt = st.i;
    if (noBuf)
      buf = new u8(sl * 3);
    var cbuf = function(l2) {
      var bl = buf.length;
      if (l2 > bl) {
        var nbuf = new u8(Math.max(bl * 2, l2));
        nbuf.set(buf);
        buf = nbuf;
      }
    };
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    var tbts = sl * 8;
    do {
      if (!lm) {
        final = bits(dat, pos, 1);
        var type = bits(dat, pos + 1, 3);
        pos += 3;
        if (!type) {
          var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
          if (t > sl) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + l);
          buf.set(dat.subarray(s, t), bt);
          st.b = bt += l, st.p = pos = t * 8, st.f = final;
          continue;
        } else if (type == 1)
          lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
        else if (type == 2) {
          var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
          var tl = hLit + bits(dat, pos + 5, 31) + 1;
          pos += 14;
          var ldt = new u8(tl);
          var clt = new u8(19);
          for (var i2 = 0; i2 < hcLen; ++i2) {
            clt[clim[i2]] = bits(dat, pos + i2 * 3, 7);
          }
          pos += hcLen * 3;
          var clb = max(clt), clbmsk = (1 << clb) - 1;
          var clm = hMap(clt, clb, 1);
          for (var i2 = 0; i2 < tl; ) {
            var r = clm[bits(dat, pos, clbmsk)];
            pos += r & 15;
            var s = r >> 4;
            if (s < 16) {
              ldt[i2++] = s;
            } else {
              var c = 0, n = 0;
              if (s == 16)
                n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i2 - 1];
              else if (s == 17)
                n = 3 + bits(dat, pos, 7), pos += 3;
              else if (s == 18)
                n = 11 + bits(dat, pos, 127), pos += 7;
              while (n--)
                ldt[i2++] = c;
            }
          }
          var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
          lbt = max(lt);
          dbt = max(dt);
          lm = hMap(lt, lbt, 1);
          dm = hMap(dt, dbt, 1);
        } else
          err(1);
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
      }
      if (resize)
        cbuf(bt + 131072);
      var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
      var lpos = pos;
      for (; ; lpos = pos) {
        var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
        pos += c & 15;
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (!c)
          err(2);
        if (sym < 256)
          buf[bt++] = sym;
        else if (sym == 256) {
          lpos = pos, lm = null;
          break;
        } else {
          var add = sym - 254;
          if (sym > 264) {
            var i2 = sym - 257, b = fleb[i2];
            add = bits(dat, pos, (1 << b) - 1) + fl[i2];
            pos += b;
          }
          var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
          if (!d)
            err(3);
          pos += d & 15;
          var dt = fd[dsym];
          if (dsym > 3) {
            var b = fdeb[dsym];
            dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
          }
          if (pos > tbts) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + 131072);
          var end = bt + add;
          if (bt < dt) {
            var shift = dl - dt, dend = Math.min(dt, end);
            if (shift + bt < 0)
              err(3);
            for (; bt < dend; ++bt)
              buf[bt] = dict[shift + bt];
          }
          for (; bt < end; ++bt)
            buf[bt] = buf[bt - dt];
        }
      }
      st.l = lm, st.p = lpos, st.b = bt, st.f = final;
      if (lm)
        final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
  };
  var et = /* @__PURE__ */ new u8(0);
  var zls = function(d, dict) {
    if ((d[0] & 15) != 8 || d[0] >> 4 > 7 || (d[0] << 8 | d[1]) % 31)
      err(6, "invalid zlib data");
    if ((d[1] >> 5 & 1) == +!dict)
      err(6, "invalid zlib data: " + (d[1] & 32 ? "need" : "unexpected") + " dictionary");
    return (d[1] >> 3 & 4) + 2;
  };
  var Inflate = /* @__PURE__ */ (function() {
    function Inflate2(opts, cb) {
      if (typeof opts == "function")
        cb = opts, opts = {};
      this.ondata = cb;
      var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
      this.s = { i: 0, b: dict ? dict.length : 0 };
      this.o = new u8(32768);
      this.p = new u8(0);
      if (dict)
        this.o.set(dict);
    }
    Inflate2.prototype.e = function(c) {
      if (!this.ondata)
        err(5);
      if (this.d)
        err(4);
      if (!this.p.length)
        this.p = c;
      else if (c.length) {
        var n = new u8(this.p.length + c.length);
        n.set(this.p), n.set(c, this.p.length), this.p = n;
      }
    };
    Inflate2.prototype.c = function(final) {
      this.s.i = +(this.d = final || false);
      var bts = this.s.b;
      var dt = inflt(this.p, this.s, this.o);
      this.ondata(slc(dt, bts, this.s.b), this.d);
      this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
      this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
    };
    Inflate2.prototype.push = function(chunk, final) {
      this.e(chunk), this.c(final);
    };
    return Inflate2;
  })();
  var Unzlib = /* @__PURE__ */ (function() {
    function Unzlib2(opts, cb) {
      Inflate.call(this, opts, cb);
      this.v = opts && opts.dictionary ? 2 : 1;
    }
    Unzlib2.prototype.push = function(chunk, final) {
      Inflate.prototype.e.call(this, chunk);
      if (this.v) {
        if (this.p.length < 6 && !final)
          return;
        this.p = this.p.subarray(zls(this.p, this.v - 1)), this.v = 0;
      }
      if (final) {
        if (this.p.length < 4)
          err(6, "invalid zlib data");
        this.p = this.p.subarray(0, -4);
      }
      Inflate.prototype.c.call(this, final);
    };
    return Unzlib2;
  })();
  function unzlibSync(data, opts) {
    return inflt(data.subarray(zls(data, opts && opts.dictionary), -4), { i: 2 }, opts && opts.out, opts && opts.dictionary);
  }
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }

  // node_modules/iobuffer/lib/text.js
  function decode(bytes, encoding = "utf8") {
    const decoder = new TextDecoder(encoding);
    return decoder.decode(bytes);
  }
  var encoder = new TextEncoder();
  function encode(str) {
    return encoder.encode(str);
  }

  // node_modules/iobuffer/lib/iobuffer.js
  var defaultByteLength = 1024 * 8;
  var hostBigEndian = (() => {
    const array = new Uint8Array(4);
    const view = new Uint32Array(array.buffer);
    return !((view[0] = 1) & array[0]);
  })();
  var typedArrays = {
    int8: globalThis.Int8Array,
    uint8: globalThis.Uint8Array,
    int16: globalThis.Int16Array,
    uint16: globalThis.Uint16Array,
    int32: globalThis.Int32Array,
    uint32: globalThis.Uint32Array,
    uint64: globalThis.BigUint64Array,
    int64: globalThis.BigInt64Array,
    float32: globalThis.Float32Array,
    float64: globalThis.Float64Array
  };
  var IOBuffer = class _IOBuffer {
    /**
     * Reference to the internal ArrayBuffer object.
     */
    buffer;
    /**
     * Byte length of the internal ArrayBuffer.
     */
    byteLength;
    /**
     * Byte offset of the internal ArrayBuffer.
     */
    byteOffset;
    /**
     * Byte length of the internal ArrayBuffer.
     */
    length;
    /**
     * The current offset of the buffer's pointer.
     */
    offset;
    lastWrittenByte;
    littleEndian;
    _data;
    _mark;
    _marks;
    /**
     * Create a new IOBuffer.
     * @param data - The data to construct the IOBuffer with.
     * If data is a number, it will be the new buffer's length<br>
     * If data is `undefined`, the buffer will be initialized with a default length of 8Kb<br>
     * If data is an ArrayBuffer, SharedArrayBuffer, an ArrayBufferView (Typed Array), an IOBuffer instance,
     * or a Node.js Buffer, a view will be created over the underlying ArrayBuffer.
     * @param options - An object for the options.
     * @returns A new IOBuffer instance.
     */
    constructor(data = defaultByteLength, options = {}) {
      let dataIsGiven = false;
      if (typeof data === "number") {
        data = new ArrayBuffer(data);
      } else {
        dataIsGiven = true;
        this.lastWrittenByte = data.byteLength;
      }
      const offset = options.offset ? options.offset >>> 0 : 0;
      const byteLength = data.byteLength - offset;
      let dvOffset = offset;
      if (ArrayBuffer.isView(data) || data instanceof _IOBuffer) {
        if (data.byteLength !== data.buffer.byteLength) {
          dvOffset = data.byteOffset + offset;
        }
        data = data.buffer;
      }
      if (dataIsGiven) {
        this.lastWrittenByte = byteLength;
      } else {
        this.lastWrittenByte = 0;
      }
      this.buffer = data;
      this.length = byteLength;
      this.byteLength = byteLength;
      this.byteOffset = dvOffset;
      this.offset = 0;
      this.littleEndian = true;
      this._data = new DataView(this.buffer, dvOffset, byteLength);
      this._mark = 0;
      this._marks = [];
    }
    /**
     * Checks if the memory allocated to the buffer is sufficient to store more
     * bytes after the offset.
     * @param byteLength - The needed memory in bytes.
     * @returns `true` if there is sufficient space and `false` otherwise.
     */
    available(byteLength = 1) {
      return this.offset + byteLength <= this.length;
    }
    /**
     * Check if little-endian mode is used for reading and writing multi-byte
     * values.
     * @returns `true` if little-endian mode is used, `false` otherwise.
     */
    isLittleEndian() {
      return this.littleEndian;
    }
    /**
     * Set little-endian mode for reading and writing multi-byte values.
     * @returns This.
     */
    setLittleEndian() {
      this.littleEndian = true;
      return this;
    }
    /**
     * Check if big-endian mode is used for reading and writing multi-byte values.
     * @returns `true` if big-endian mode is used, `false` otherwise.
     */
    isBigEndian() {
      return !this.littleEndian;
    }
    /**
     * Switches to big-endian mode for reading and writing multi-byte values.
     * @returns This.
     */
    setBigEndian() {
      this.littleEndian = false;
      return this;
    }
    /**
     * Move the pointer n bytes forward.
     * @param n - Number of bytes to skip.
     * @returns This.
     */
    skip(n = 1) {
      this.offset += n;
      return this;
    }
    /**
     * Move the pointer n bytes backward.
     * @param n - Number of bytes to move back.
     * @returns This.
     */
    back(n = 1) {
      this.offset -= n;
      return this;
    }
    /**
     * Move the pointer to the given offset.
     * @param offset - The offset to move to.
     * @returns This.
     */
    seek(offset) {
      this.offset = offset;
      return this;
    }
    /**
     * Store the current pointer offset.
     * @see {@link IOBuffer#reset}
     * @returns This.
     */
    mark() {
      this._mark = this.offset;
      return this;
    }
    /**
     * Move the pointer back to the last pointer offset set by mark.
     * @see {@link IOBuffer#mark}
     * @returns This.
     */
    reset() {
      this.offset = this._mark;
      return this;
    }
    /**
     * Push the current pointer offset to the mark stack.
     * @see {@link IOBuffer#popMark}
     * @returns This.
     */
    pushMark() {
      this._marks.push(this.offset);
      return this;
    }
    /**
     * Pop the last pointer offset from the mark stack, and set the current
     * pointer offset to the popped value.
     * @see {@link IOBuffer#pushMark}
     * @returns This.
     */
    popMark() {
      const offset = this._marks.pop();
      if (offset === void 0) {
        throw new Error("Mark stack empty");
      }
      this.seek(offset);
      return this;
    }
    /**
     * Move the pointer offset back to 0.
     * @returns This.
     */
    rewind() {
      this.offset = 0;
      return this;
    }
    /**
     * Make sure the buffer has sufficient memory to write a given byteLength at
     * the current pointer offset.
     * If the buffer's memory is insufficient, this method will create a new
     * buffer (a copy) with a length that is twice (byteLength + current offset).
     * @param byteLength - The needed memory in bytes.
     * @returns This.
     */
    ensureAvailable(byteLength = 1) {
      if (!this.available(byteLength)) {
        const lengthNeeded = this.offset + byteLength;
        const newLength = lengthNeeded * 2;
        const newArray = new Uint8Array(newLength);
        newArray.set(new Uint8Array(this.buffer));
        this.buffer = newArray.buffer;
        this.length = newLength;
        this.byteLength = newLength;
        this._data = new DataView(this.buffer);
      }
      return this;
    }
    /**
     * Read a byte and return false if the byte's value is 0, or true otherwise.
     * Moves pointer forward by one byte.
     * @returns The read boolean.
     */
    readBoolean() {
      return this.readUint8() !== 0;
    }
    /**
     * Read a signed 8-bit integer and move pointer forward by 1 byte.
     * @returns The read byte.
     */
    readInt8() {
      return this._data.getInt8(this.offset++);
    }
    /**
     * Read an unsigned 8-bit integer and move pointer forward by 1 byte.
     * @returns The read byte.
     */
    readUint8() {
      return this._data.getUint8(this.offset++);
    }
    /**
     * Alias for {@link IOBuffer#readUint8}.
     * @returns The read byte.
     */
    readByte() {
      return this.readUint8();
    }
    /**
     * Read `n` bytes and move pointer forward by `n` bytes.
     * @param n - Number of bytes to read.
     * @returns The read bytes.
     */
    readBytes(n = 1) {
      return this.readArray(n, "uint8");
    }
    /**
     * Creates an array of corresponding to the type `type` and size `size`.
     * For example, type `uint8` will create a `Uint8Array`.
     * @param size - size of the resulting array
     * @param type - number type of elements to read
     * @returns The read array.
     */
    readArray(size, type) {
      const bytes = typedArrays[type].BYTES_PER_ELEMENT * size;
      const offset = this.byteOffset + this.offset;
      const slice = this.buffer.slice(offset, offset + bytes);
      if (this.littleEndian === hostBigEndian && type !== "uint8" && type !== "int8") {
        const slice2 = new Uint8Array(this.buffer.slice(offset, offset + bytes));
        slice2.reverse();
        const returnArray2 = new typedArrays[type](slice2.buffer);
        this.offset += bytes;
        returnArray2.reverse();
        return returnArray2;
      }
      const returnArray = new typedArrays[type](slice);
      this.offset += bytes;
      return returnArray;
    }
    /**
     * Read a 16-bit signed integer and move pointer forward by 2 bytes.
     * @returns The read value.
     */
    readInt16() {
      const value = this._data.getInt16(this.offset, this.littleEndian);
      this.offset += 2;
      return value;
    }
    /**
     * Read a 16-bit unsigned integer and move pointer forward by 2 bytes.
     * @returns The read value.
     */
    readUint16() {
      const value = this._data.getUint16(this.offset, this.littleEndian);
      this.offset += 2;
      return value;
    }
    /**
     * Read a 32-bit signed integer and move pointer forward by 4 bytes.
     * @returns The read value.
     */
    readInt32() {
      const value = this._data.getInt32(this.offset, this.littleEndian);
      this.offset += 4;
      return value;
    }
    /**
     * Read a 32-bit unsigned integer and move pointer forward by 4 bytes.
     * @returns The read value.
     */
    readUint32() {
      const value = this._data.getUint32(this.offset, this.littleEndian);
      this.offset += 4;
      return value;
    }
    /**
     * Read a 32-bit floating number and move pointer forward by 4 bytes.
     * @returns The read value.
     */
    readFloat32() {
      const value = this._data.getFloat32(this.offset, this.littleEndian);
      this.offset += 4;
      return value;
    }
    /**
     * Read a 64-bit floating number and move pointer forward by 8 bytes.
     * @returns The read value.
     */
    readFloat64() {
      const value = this._data.getFloat64(this.offset, this.littleEndian);
      this.offset += 8;
      return value;
    }
    /**
     * Read a 64-bit signed integer number and move pointer forward by 8 bytes.
     * @returns The read value.
     */
    readBigInt64() {
      const value = this._data.getBigInt64(this.offset, this.littleEndian);
      this.offset += 8;
      return value;
    }
    /**
     * Read a 64-bit unsigned integer number and move pointer forward by 8 bytes.
     * @returns The read value.
     */
    readBigUint64() {
      const value = this._data.getBigUint64(this.offset, this.littleEndian);
      this.offset += 8;
      return value;
    }
    /**
     * Read a 1-byte ASCII character and move pointer forward by 1 byte.
     * @returns The read character.
     */
    readChar() {
      return String.fromCharCode(this.readInt8());
    }
    /**
     * Read `n` 1-byte ASCII characters and move pointer forward by `n` bytes.
     * @param n - Number of characters to read.
     * @returns The read characters.
     */
    readChars(n = 1) {
      let result = "";
      for (let i2 = 0; i2 < n; i2++) {
        result += this.readChar();
      }
      return result;
    }
    /**
     * Read the next `n` bytes, return a UTF-8 decoded string and move pointer
     * forward by `n` bytes.
     * @param n - Number of bytes to read.
     * @returns The decoded string.
     */
    readUtf8(n = 1) {
      return decode(this.readBytes(n));
    }
    /**
     * Read the next `n` bytes, return a string decoded with `encoding` and move pointer
     * forward by `n` bytes.
     * If no encoding is passed, the function is equivalent to @see {@link IOBuffer#readUtf8}
     * @param n - Number of bytes to read.
     * @param encoding - The encoding to use. Default is 'utf8'.
     * @returns The decoded string.
     */
    decodeText(n = 1, encoding = "utf8") {
      return decode(this.readBytes(n), encoding);
    }
    /**
     * Write 0xff if the passed value is truthy, 0x00 otherwise and move pointer
     * forward by 1 byte.
     * @param value - The value to write.
     * @returns This.
     */
    writeBoolean(value) {
      this.writeUint8(value ? 255 : 0);
      return this;
    }
    /**
     * Write `value` as an 8-bit signed integer and move pointer forward by 1 byte.
     * @param value - The value to write.
     * @returns This.
     */
    writeInt8(value) {
      this.ensureAvailable(1);
      this._data.setInt8(this.offset++, value);
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as an 8-bit unsigned integer and move pointer forward by 1
     * byte.
     * @param value - The value to write.
     * @returns This.
     */
    writeUint8(value) {
      this.ensureAvailable(1);
      this._data.setUint8(this.offset++, value);
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * An alias for {@link IOBuffer#writeUint8}.
     * @param value - The value to write.
     * @returns This.
     */
    writeByte(value) {
      return this.writeUint8(value);
    }
    /**
     * Write all elements of `bytes` as uint8 values and move pointer forward by
     * `bytes.length` bytes.
     * @param bytes - The array of bytes to write.
     * @returns This.
     */
    writeBytes(bytes) {
      this.ensureAvailable(bytes.length);
      for (let i2 = 0; i2 < bytes.length; i2++) {
        this._data.setUint8(this.offset++, bytes[i2]);
      }
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 16-bit signed integer and move pointer forward by 2
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeInt16(value) {
      this.ensureAvailable(2);
      this._data.setInt16(this.offset, value, this.littleEndian);
      this.offset += 2;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 16-bit unsigned integer and move pointer forward by 2
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeUint16(value) {
      this.ensureAvailable(2);
      this._data.setUint16(this.offset, value, this.littleEndian);
      this.offset += 2;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 32-bit signed integer and move pointer forward by 4
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeInt32(value) {
      this.ensureAvailable(4);
      this._data.setInt32(this.offset, value, this.littleEndian);
      this.offset += 4;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 32-bit unsigned integer and move pointer forward by 4
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeUint32(value) {
      this.ensureAvailable(4);
      this._data.setUint32(this.offset, value, this.littleEndian);
      this.offset += 4;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 32-bit floating number and move pointer forward by 4
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeFloat32(value) {
      this.ensureAvailable(4);
      this._data.setFloat32(this.offset, value, this.littleEndian);
      this.offset += 4;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 64-bit floating number and move pointer forward by 8
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeFloat64(value) {
      this.ensureAvailable(8);
      this._data.setFloat64(this.offset, value, this.littleEndian);
      this.offset += 8;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 64-bit signed bigint and move pointer forward by 8
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeBigInt64(value) {
      this.ensureAvailable(8);
      this._data.setBigInt64(this.offset, value, this.littleEndian);
      this.offset += 8;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write `value` as a 64-bit unsigned bigint and move pointer forward by 8
     * bytes.
     * @param value - The value to write.
     * @returns This.
     */
    writeBigUint64(value) {
      this.ensureAvailable(8);
      this._data.setBigUint64(this.offset, value, this.littleEndian);
      this.offset += 8;
      this._updateLastWrittenByte();
      return this;
    }
    /**
     * Write the charCode of `str`'s first character as an 8-bit unsigned integer
     * and move pointer forward by 1 byte.
     * @param str - The character to write.
     * @returns This.
     */
    writeChar(str) {
      return this.writeUint8(str.charCodeAt(0));
    }
    /**
     * Write the charCodes of all `str`'s characters as 8-bit unsigned integers
     * and move pointer forward by `str.length` bytes.
     * @param str - The characters to write.
     * @returns This.
     */
    writeChars(str) {
      for (let i2 = 0; i2 < str.length; i2++) {
        this.writeUint8(str.charCodeAt(i2));
      }
      return this;
    }
    /**
     * UTF-8 encode and write `str` to the current pointer offset and move pointer
     * forward according to the encoded length.
     * @param str - The string to write.
     * @returns This.
     */
    writeUtf8(str) {
      return this.writeBytes(encode(str));
    }
    /**
     * Export a Uint8Array view of the internal buffer.
     * The view starts at the byte offset and its length
     * is calculated to stop at the last written byte or the original length.
     * @returns A new Uint8Array view.
     */
    toArray() {
      return new Uint8Array(this.buffer, this.byteOffset, this.lastWrittenByte);
    }
    /**
     *  Get the total number of bytes written so far, regardless of the current offset.
     * @returns - Total number of bytes.
     */
    getWrittenByteLength() {
      return this.lastWrittenByte - this.byteOffset;
    }
    /**
     * Update the last written byte offset
     * @private
     */
    _updateLastWrittenByte() {
      if (this.offset > this.lastWrittenByte) {
        this.lastWrittenByte = this.offset;
      }
    }
  };

  // node_modules/fast-png/lib/helpers/crc.js
  var crcTable = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 3988292384 ^ c >>> 1;
      } else {
        c = c >>> 1;
      }
    }
    crcTable[n] = c;
  }
  var initialCrc = 4294967295;
  function updateCrc(currentCrc, data, length) {
    let c = currentCrc;
    for (let n = 0; n < length; n++) {
      c = crcTable[(c ^ data[n]) & 255] ^ c >>> 8;
    }
    return c;
  }
  function crc(data, length) {
    return (updateCrc(initialCrc, data, length) ^ initialCrc) >>> 0;
  }
  function checkCrc(buffer, crcLength, chunkName) {
    const expectedCrc = buffer.readUint32();
    const actualCrc = crc(new Uint8Array(buffer.buffer, buffer.byteOffset + buffer.offset - crcLength - 4, crcLength), crcLength);
    if (actualCrc !== expectedCrc) {
      throw new Error(`CRC mismatch for chunk ${chunkName}. Expected ${expectedCrc}, found ${actualCrc}`);
    }
  }

  // node_modules/fast-png/lib/helpers/unfilter.js
  function unfilterNone(currentLine, newLine, bytesPerLine) {
    for (let i2 = 0; i2 < bytesPerLine; i2++) {
      newLine[i2] = currentLine[i2];
    }
  }
  function unfilterSub(currentLine, newLine, bytesPerLine, bytesPerPixel) {
    let i2 = 0;
    for (; i2 < bytesPerPixel; i2++) {
      newLine[i2] = currentLine[i2];
    }
    for (; i2 < bytesPerLine; i2++) {
      newLine[i2] = currentLine[i2] + newLine[i2 - bytesPerPixel] & 255;
    }
  }
  function unfilterUp(currentLine, newLine, prevLine, bytesPerLine) {
    let i2 = 0;
    if (prevLine.length === 0) {
      for (; i2 < bytesPerLine; i2++) {
        newLine[i2] = currentLine[i2];
      }
    } else {
      for (; i2 < bytesPerLine; i2++) {
        newLine[i2] = currentLine[i2] + prevLine[i2] & 255;
      }
    }
  }
  function unfilterAverage(currentLine, newLine, prevLine, bytesPerLine, bytesPerPixel) {
    let i2 = 0;
    if (prevLine.length === 0) {
      for (; i2 < bytesPerPixel; i2++) {
        newLine[i2] = currentLine[i2];
      }
      for (; i2 < bytesPerLine; i2++) {
        newLine[i2] = currentLine[i2] + (newLine[i2 - bytesPerPixel] >> 1) & 255;
      }
    } else {
      for (; i2 < bytesPerPixel; i2++) {
        newLine[i2] = currentLine[i2] + (prevLine[i2] >> 1) & 255;
      }
      for (; i2 < bytesPerLine; i2++) {
        newLine[i2] = currentLine[i2] + (newLine[i2 - bytesPerPixel] + prevLine[i2] >> 1) & 255;
      }
    }
  }
  function unfilterPaeth(currentLine, newLine, prevLine, bytesPerLine, bytesPerPixel) {
    let i2 = 0;
    if (prevLine.length === 0) {
      for (; i2 < bytesPerPixel; i2++) {
        newLine[i2] = currentLine[i2];
      }
      for (; i2 < bytesPerLine; i2++) {
        newLine[i2] = currentLine[i2] + newLine[i2 - bytesPerPixel] & 255;
      }
    } else {
      for (; i2 < bytesPerPixel; i2++) {
        newLine[i2] = currentLine[i2] + prevLine[i2] & 255;
      }
      for (; i2 < bytesPerLine; i2++) {
        newLine[i2] = currentLine[i2] + paethPredictor(newLine[i2 - bytesPerPixel], prevLine[i2], prevLine[i2 - bytesPerPixel]) & 255;
      }
    }
  }
  function paethPredictor(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc)
      return a;
    else if (pb <= pc)
      return b;
    else
      return c;
  }

  // node_modules/fast-png/lib/helpers/apply_unfilter.js
  function applyUnfilter(filterType, currentLine, newLine, prevLine, passLineBytes, bytesPerPixel) {
    switch (filterType) {
      case 0:
        unfilterNone(currentLine, newLine, passLineBytes);
        break;
      case 1:
        unfilterSub(currentLine, newLine, passLineBytes, bytesPerPixel);
        break;
      case 2:
        unfilterUp(currentLine, newLine, prevLine, passLineBytes);
        break;
      case 3:
        unfilterAverage(currentLine, newLine, prevLine, passLineBytes, bytesPerPixel);
        break;
      case 4:
        unfilterPaeth(currentLine, newLine, prevLine, passLineBytes, bytesPerPixel);
        break;
      default:
        throw new Error(`Unsupported filter: ${filterType}`);
    }
  }

  // node_modules/fast-png/lib/helpers/decode_interlace_adam7.js
  var uint16 = new Uint16Array([255]);
  var uint8 = new Uint8Array(uint16.buffer);
  var osIsLittleEndian = uint8[0] === 255;
  function decodeInterlaceAdam7(params) {
    const { data, width, height, channels, depth } = params;
    const passes = [
      { x: 0, y: 0, xStep: 8, yStep: 8 },
      // Pass 1
      { x: 4, y: 0, xStep: 8, yStep: 8 },
      // Pass 2
      { x: 0, y: 4, xStep: 4, yStep: 8 },
      // Pass 3
      { x: 2, y: 0, xStep: 4, yStep: 4 },
      // Pass 4
      { x: 0, y: 2, xStep: 2, yStep: 4 },
      // Pass 5
      { x: 1, y: 0, xStep: 2, yStep: 2 },
      // Pass 6
      { x: 0, y: 1, xStep: 1, yStep: 2 }
      // Pass 7
    ];
    const bytesPerPixel = Math.ceil(depth / 8) * channels;
    const resultData = new Uint8Array(height * width * bytesPerPixel);
    let offset = 0;
    for (let passIndex = 0; passIndex < 7; passIndex++) {
      const pass = passes[passIndex];
      const passWidth = Math.ceil((width - pass.x) / pass.xStep);
      const passHeight = Math.ceil((height - pass.y) / pass.yStep);
      if (passWidth <= 0 || passHeight <= 0)
        continue;
      const passLineBytes = passWidth * bytesPerPixel;
      const prevLine = new Uint8Array(passLineBytes);
      for (let y = 0; y < passHeight; y++) {
        const filterType = data[offset++];
        const currentLine = data.subarray(offset, offset + passLineBytes);
        offset += passLineBytes;
        const newLine = new Uint8Array(passLineBytes);
        applyUnfilter(filterType, currentLine, newLine, prevLine, passLineBytes, bytesPerPixel);
        prevLine.set(newLine);
        for (let x2 = 0; x2 < passWidth; x2++) {
          const outputX = pass.x + x2 * pass.xStep;
          const outputY = pass.y + y * pass.yStep;
          if (outputX >= width || outputY >= height)
            continue;
          for (let i2 = 0; i2 < bytesPerPixel; i2++) {
            resultData[(outputY * width + outputX) * bytesPerPixel + i2] = newLine[x2 * bytesPerPixel + i2];
          }
        }
      }
    }
    if (depth === 16) {
      const uint16Data = new Uint16Array(resultData.buffer);
      if (osIsLittleEndian) {
        for (let k = 0; k < uint16Data.length; k++) {
          uint16Data[k] = swap16(uint16Data[k]);
        }
      }
      return uint16Data;
    } else {
      return resultData;
    }
  }
  function swap16(val) {
    return (val & 255) << 8 | val >> 8 & 255;
  }

  // node_modules/fast-png/lib/helpers/decode_interlace_null.js
  var uint162 = new Uint16Array([255]);
  var uint82 = new Uint8Array(uint162.buffer);
  var osIsLittleEndian2 = uint82[0] === 255;
  var empty = new Uint8Array(0);
  function decodeInterlaceNull(params) {
    const { data, width, height, channels, depth } = params;
    const bytesPerPixel = Math.ceil(depth / 8) * channels;
    const bytesPerLine = Math.ceil(depth / 8 * channels * width);
    const newData = new Uint8Array(height * bytesPerLine);
    let prevLine = empty;
    let offset = 0;
    let currentLine;
    let newLine;
    for (let i2 = 0; i2 < height; i2++) {
      currentLine = data.subarray(offset + 1, offset + 1 + bytesPerLine);
      newLine = newData.subarray(i2 * bytesPerLine, (i2 + 1) * bytesPerLine);
      switch (data[offset]) {
        case 0:
          unfilterNone(currentLine, newLine, bytesPerLine);
          break;
        case 1:
          unfilterSub(currentLine, newLine, bytesPerLine, bytesPerPixel);
          break;
        case 2:
          unfilterUp(currentLine, newLine, prevLine, bytesPerLine);
          break;
        case 3:
          unfilterAverage(currentLine, newLine, prevLine, bytesPerLine, bytesPerPixel);
          break;
        case 4:
          unfilterPaeth(currentLine, newLine, prevLine, bytesPerLine, bytesPerPixel);
          break;
        default:
          throw new Error(`Unsupported filter: ${data[offset]}`);
      }
      prevLine = newLine;
      offset += bytesPerLine + 1;
    }
    if (depth === 16) {
      const uint16Data = new Uint16Array(newData.buffer);
      if (osIsLittleEndian2) {
        for (let k = 0; k < uint16Data.length; k++) {
          uint16Data[k] = swap162(uint16Data[k]);
        }
      }
      return uint16Data;
    } else {
      return newData;
    }
  }
  function swap162(val) {
    return (val & 255) << 8 | val >> 8 & 255;
  }

  // node_modules/fast-png/lib/helpers/signature.js
  var pngSignature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
  function checkSignature(buffer) {
    if (!hasPngSignature(buffer.readBytes(pngSignature.length))) {
      throw new Error("wrong PNG signature");
    }
  }
  function hasPngSignature(array) {
    if (array.length < pngSignature.length) {
      return false;
    }
    for (let i2 = 0; i2 < pngSignature.length; i2++) {
      if (array[i2] !== pngSignature[i2]) {
        return false;
      }
    }
    return true;
  }

  // node_modules/fast-png/lib/helpers/text.js
  var textChunkName = "tEXt";
  var NULL = 0;
  var latin1Decoder = new TextDecoder("latin1");
  function validateKeyword(keyword) {
    validateLatin1(keyword);
    if (keyword.length === 0 || keyword.length > 79) {
      throw new Error("keyword length must be between 1 and 79");
    }
  }
  var latin1Regex = /^[\u0000-\u00FF]*$/;
  function validateLatin1(text) {
    if (!latin1Regex.test(text)) {
      throw new Error("invalid latin1 text");
    }
  }
  function decodetEXt(text, buffer, length) {
    const keyword = readKeyword(buffer);
    text[keyword] = readLatin1(buffer, length - keyword.length - 1);
  }
  function readKeyword(buffer) {
    buffer.mark();
    while (buffer.readByte() !== NULL) {
    }
    const end = buffer.offset;
    buffer.reset();
    const keyword = latin1Decoder.decode(buffer.readBytes(end - buffer.offset - 1));
    buffer.skip(1);
    validateKeyword(keyword);
    return keyword;
  }
  function readLatin1(buffer, length) {
    return latin1Decoder.decode(buffer.readBytes(length));
  }

  // node_modules/fast-png/lib/internal_types.js
  var ColorType = {
    UNKNOWN: -1,
    GREYSCALE: 0,
    TRUECOLOUR: 2,
    INDEXED_COLOUR: 3,
    GREYSCALE_ALPHA: 4,
    TRUECOLOUR_ALPHA: 6
  };
  var CompressionMethod = {
    UNKNOWN: -1,
    DEFLATE: 0
  };
  var FilterMethod = {
    UNKNOWN: -1,
    ADAPTIVE: 0
  };
  var InterlaceMethod = {
    UNKNOWN: -1,
    NO_INTERLACE: 0,
    ADAM7: 1
  };
  var DisposeOpType = {
    NONE: 0,
    BACKGROUND: 1,
    PREVIOUS: 2
  };
  var BlendOpType = {
    SOURCE: 0,
    OVER: 1
  };

  // node_modules/fast-png/lib/png_decoder.js
  var PngDecoder = class extends IOBuffer {
    _checkCrc;
    _inflator;
    _png;
    _apng;
    _end;
    _hasPalette;
    _palette;
    _hasTransparency;
    _transparency;
    _compressionMethod;
    _filterMethod;
    _interlaceMethod;
    _colorType;
    _isAnimated;
    _numberOfFrames;
    _numberOfPlays;
    _frames;
    _writingDataChunks;
    _chunks;
    _inflatorResult;
    constructor(data, options = {}) {
      super(data);
      const { checkCrc: checkCrc2 = false } = options;
      this._checkCrc = checkCrc2;
      this._inflator = new Unzlib((chunk, final) => {
        this._chunks.push(chunk);
        if (final) {
          const totalLength = this._chunks.reduce((sum, c) => sum + c.length, 0);
          this._inflatorResult = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk2 of this._chunks) {
            this._inflatorResult.set(chunk2, offset);
            offset += chunk2.length;
          }
          this._chunks = [];
        }
      });
      this._chunks = [];
      this._png = {
        width: -1,
        height: -1,
        channels: -1,
        data: new Uint8Array(0),
        depth: 1,
        text: {}
      };
      this._apng = {
        width: -1,
        height: -1,
        channels: -1,
        depth: 1,
        numberOfFrames: 1,
        numberOfPlays: 0,
        text: {},
        frames: []
      };
      this._end = false;
      this._hasPalette = false;
      this._palette = [];
      this._hasTransparency = false;
      this._transparency = new Uint16Array(0);
      this._compressionMethod = CompressionMethod.UNKNOWN;
      this._filterMethod = FilterMethod.UNKNOWN;
      this._interlaceMethod = InterlaceMethod.UNKNOWN;
      this._colorType = ColorType.UNKNOWN;
      this._isAnimated = false;
      this._numberOfFrames = 1;
      this._numberOfPlays = 0;
      this._frames = [];
      this._writingDataChunks = false;
      this._inflatorResult = new Uint8Array(0);
      this.setBigEndian();
    }
    decode() {
      checkSignature(this);
      while (!this._end) {
        const length = this.readUint32();
        const type = this.readChars(4);
        this.decodeChunk(length, type);
      }
      this._inflator.push(new Uint8Array(0), true);
      this.decodeImage();
      return this._png;
    }
    decodeApng() {
      checkSignature(this);
      while (!this._end) {
        const length = this.readUint32();
        const type = this.readChars(4);
        this.decodeApngChunk(length, type);
      }
      this.decodeApngImage();
      return this._apng;
    }
    // https://www.w3.org/TR/PNG/#5Chunk-layout
    decodeChunk(length, type) {
      const offset = this.offset;
      switch (type) {
        // 11.2 Critical chunks
        case "IHDR":
          this.decodeIHDR();
          break;
        case "PLTE":
          this.decodePLTE(length);
          break;
        case "IDAT":
          this.decodeIDAT(length);
          break;
        case "IEND":
          this._end = true;
          break;
        // 11.3 Ancillary chunks
        case "tRNS":
          this.decodetRNS(length);
          break;
        case "iCCP":
          this.decodeiCCP(length);
          break;
        case textChunkName:
          decodetEXt(this._png.text, this, length);
          break;
        case "pHYs":
          this.decodepHYs();
          break;
        default:
          this.skip(length);
          break;
      }
      if (this.offset - offset !== length) {
        throw new Error(`Length mismatch while decoding chunk ${type}`);
      }
      if (this._checkCrc) {
        checkCrc(this, length + 4, type);
      } else {
        this.skip(4);
      }
    }
    decodeApngChunk(length, type) {
      const offset = this.offset;
      if (type !== "fdAT" && type !== "IDAT" && this._writingDataChunks) {
        this.pushDataToFrame();
      }
      switch (type) {
        case "acTL":
          this.decodeACTL();
          break;
        case "fcTL":
          this.decodeFCTL();
          break;
        case "fdAT":
          this.decodeFDAT(length);
          break;
        default:
          this.decodeChunk(length, type);
          this.offset = offset + length;
          break;
      }
      if (this.offset - offset !== length) {
        throw new Error(`Length mismatch while decoding chunk ${type}`);
      }
      if (this._checkCrc) {
        checkCrc(this, length + 4, type);
      } else {
        this.skip(4);
      }
    }
    // https://www.w3.org/TR/PNG/#11IHDR
    decodeIHDR() {
      const image = this._png;
      image.width = this.readUint32();
      image.height = this.readUint32();
      image.depth = checkBitDepth(this.readUint8());
      const colorType = this.readUint8();
      this._colorType = colorType;
      let channels;
      switch (colorType) {
        case ColorType.GREYSCALE:
          channels = 1;
          break;
        case ColorType.TRUECOLOUR:
          channels = 3;
          break;
        case ColorType.INDEXED_COLOUR:
          channels = 1;
          break;
        case ColorType.GREYSCALE_ALPHA:
          channels = 2;
          break;
        case ColorType.TRUECOLOUR_ALPHA:
          channels = 4;
          break;
        // Kept for exhaustiveness.
        // eslint-disable-next-line unicorn/no-useless-switch-case
        case ColorType.UNKNOWN:
        default:
          throw new Error(`Unknown color type: ${colorType}`);
      }
      this._png.channels = channels;
      this._compressionMethod = this.readUint8();
      if (this._compressionMethod !== CompressionMethod.DEFLATE) {
        throw new Error(`Unsupported compression method: ${this._compressionMethod}`);
      }
      this._filterMethod = this.readUint8();
      this._interlaceMethod = this.readUint8();
    }
    decodeACTL() {
      this._numberOfFrames = this.readUint32();
      this._numberOfPlays = this.readUint32();
      this._isAnimated = true;
    }
    decodeFCTL() {
      const image = {
        sequenceNumber: this.readUint32(),
        width: this.readUint32(),
        height: this.readUint32(),
        xOffset: this.readUint32(),
        yOffset: this.readUint32(),
        delayNumber: this.readUint16(),
        delayDenominator: this.readUint16(),
        disposeOp: this.readUint8(),
        blendOp: this.readUint8(),
        data: new Uint8Array(0)
      };
      this._frames.push(image);
    }
    // https://www.w3.org/TR/PNG/#11PLTE
    decodePLTE(length) {
      if (length % 3 !== 0) {
        throw new RangeError(`PLTE field length must be a multiple of 3. Got ${length}`);
      }
      const l = length / 3;
      this._hasPalette = true;
      const palette = [];
      this._palette = palette;
      for (let i2 = 0; i2 < l; i2++) {
        palette.push([this.readUint8(), this.readUint8(), this.readUint8()]);
      }
    }
    // https://www.w3.org/TR/PNG/#11IDAT
    decodeIDAT(length) {
      this._writingDataChunks = true;
      const dataLength = length;
      const dataOffset = this.offset + this.byteOffset;
      try {
        this._inflator.push(new Uint8Array(this.buffer, dataOffset, dataLength), false);
      } catch (error) {
        throw new Error("Error while decompressing the data:", { cause: error });
      }
      this.skip(length);
    }
    decodeFDAT(length) {
      this._writingDataChunks = true;
      let dataLength = length;
      let dataOffset = this.offset + this.byteOffset;
      dataOffset += 4;
      dataLength -= 4;
      try {
        this._inflator.push(new Uint8Array(this.buffer, dataOffset, dataLength), false);
      } catch (error) {
        throw new Error("Error while decompressing the data:", { cause: error });
      }
      this.skip(length);
    }
    // https://www.w3.org/TR/PNG/#11tRNS
    decodetRNS(length) {
      switch (this._colorType) {
        case ColorType.GREYSCALE:
        case ColorType.TRUECOLOUR: {
          if (length % 2 !== 0) {
            throw new RangeError(`tRNS chunk length must be a multiple of 2. Got ${length}`);
          }
          if (length / 2 > this._png.width * this._png.height) {
            throw new Error(`tRNS chunk contains more alpha values than there are pixels (${length / 2} vs ${this._png.width * this._png.height})`);
          }
          this._hasTransparency = true;
          this._transparency = new Uint16Array(length / 2);
          for (let i2 = 0; i2 < length / 2; i2++) {
            this._transparency[i2] = this.readUint16();
          }
          break;
        }
        case ColorType.INDEXED_COLOUR: {
          if (length > this._palette.length) {
            throw new Error(`tRNS chunk contains more alpha values than there are palette colors (${length} vs ${this._palette.length})`);
          }
          let i2 = 0;
          for (; i2 < length; i2++) {
            const alpha = this.readByte();
            this._palette[i2].push(alpha);
          }
          for (; i2 < this._palette.length; i2++) {
            this._palette[i2].push(255);
          }
          break;
        }
        // Kept for exhaustiveness.
        /* eslint-disable unicorn/no-useless-switch-case */
        case ColorType.UNKNOWN:
        case ColorType.GREYSCALE_ALPHA:
        case ColorType.TRUECOLOUR_ALPHA:
        default: {
          throw new Error(`tRNS chunk is not supported for color type ${this._colorType}`);
        }
      }
    }
    // https://www.w3.org/TR/PNG/#11iCCP
    decodeiCCP(length) {
      const name = readKeyword(this);
      const compressionMethod = this.readUint8();
      if (compressionMethod !== CompressionMethod.DEFLATE) {
        throw new Error(`Unsupported iCCP compression method: ${compressionMethod}`);
      }
      const compressedProfile = this.readBytes(length - name.length - 2);
      this._png.iccEmbeddedProfile = {
        name,
        profile: unzlibSync(compressedProfile)
      };
    }
    // https://www.w3.org/TR/PNG/#11pHYs
    decodepHYs() {
      const ppuX = this.readUint32();
      const ppuY = this.readUint32();
      const unitSpecifier = this.readByte();
      this._png.resolution = {
        x: ppuX,
        y: ppuY,
        unit: unitSpecifier
      };
    }
    decodeApngImage() {
      this._apng.width = this._png.width;
      this._apng.height = this._png.height;
      this._apng.channels = this._png.channels;
      this._apng.depth = this._png.depth;
      this._apng.numberOfFrames = this._numberOfFrames;
      this._apng.numberOfPlays = this._numberOfPlays;
      this._apng.text = this._png.text;
      this._apng.resolution = this._png.resolution;
      for (let i2 = 0; i2 < this._numberOfFrames; i2++) {
        const newFrame = {
          sequenceNumber: this._frames[i2].sequenceNumber,
          delayNumber: this._frames[i2].delayNumber,
          delayDenominator: this._frames[i2].delayDenominator,
          data: this._apng.depth === 8 ? new Uint8Array(this._apng.width * this._apng.height * this._apng.channels) : new Uint16Array(this._apng.width * this._apng.height * this._apng.channels)
        };
        const frame = this._frames.at(i2);
        if (frame) {
          frame.data = decodeInterlaceNull({
            data: frame.data,
            width: frame.width,
            height: frame.height,
            channels: this._apng.channels,
            depth: this._apng.depth
          });
          if (this._hasPalette) {
            this._apng.palette = this._palette;
          }
          if (this._hasTransparency) {
            this._apng.transparency = this._transparency;
          }
          if (i2 === 0 || frame.xOffset === 0 && frame.yOffset === 0 && frame.width === this._png.width && frame.height === this._png.height) {
            newFrame.data = frame.data;
          } else {
            const prevFrame = this._apng.frames.at(i2 - 1);
            this.disposeFrame(frame, prevFrame, newFrame);
            this.addFrameDataToCanvas(newFrame, frame);
          }
          this._apng.frames.push(newFrame);
        }
      }
      return this._apng;
    }
    disposeFrame(frame, prevFrame, imageFrame) {
      switch (frame.disposeOp) {
        case DisposeOpType.NONE:
          break;
        case DisposeOpType.BACKGROUND:
          for (let row = 0; row < this._png.height; row++) {
            for (let col = 0; col < this._png.width; col++) {
              const index = (row * frame.width + col) * this._png.channels;
              for (let channel = 0; channel < this._png.channels; channel++) {
                imageFrame.data[index + channel] = 0;
              }
            }
          }
          break;
        case DisposeOpType.PREVIOUS:
          imageFrame.data.set(prevFrame.data);
          break;
        default:
          throw new Error("Unknown disposeOp");
      }
    }
    addFrameDataToCanvas(imageFrame, frame) {
      const maxValue = 1 << this._png.depth;
      const calculatePixelIndices = (row, col) => {
        const index = ((row + frame.yOffset) * this._png.width + frame.xOffset + col) * this._png.channels;
        const frameIndex = (row * frame.width + col) * this._png.channels;
        return { index, frameIndex };
      };
      switch (frame.blendOp) {
        case BlendOpType.SOURCE:
          for (let row = 0; row < frame.height; row++) {
            for (let col = 0; col < frame.width; col++) {
              const { index, frameIndex } = calculatePixelIndices(row, col);
              for (let channel = 0; channel < this._png.channels; channel++) {
                imageFrame.data[index + channel] = frame.data[frameIndex + channel];
              }
            }
          }
          break;
        // https://www.w3.org/TR/png-3/#13Alpha-channel-processing
        case BlendOpType.OVER:
          for (let row = 0; row < frame.height; row++) {
            for (let col = 0; col < frame.width; col++) {
              const { index, frameIndex } = calculatePixelIndices(row, col);
              for (let channel = 0; channel < this._png.channels; channel++) {
                const sourceAlpha = frame.data[frameIndex + this._png.channels - 1] / maxValue;
                const foregroundValue = channel % (this._png.channels - 1) === 0 ? 1 : frame.data[frameIndex + channel];
                const value = Math.floor(sourceAlpha * foregroundValue + (1 - sourceAlpha) * imageFrame.data[index + channel]);
                imageFrame.data[index + channel] += value;
              }
            }
          }
          break;
        default:
          throw new Error("Unknown blendOp");
      }
    }
    decodeImage() {
      const data = this._inflatorResult;
      if (this._filterMethod !== FilterMethod.ADAPTIVE) {
        throw new Error(`Filter method ${this._filterMethod} not supported`);
      }
      if (this._interlaceMethod === InterlaceMethod.NO_INTERLACE) {
        this._png.data = decodeInterlaceNull({
          data,
          width: this._png.width,
          height: this._png.height,
          channels: this._png.channels,
          depth: this._png.depth
        });
      } else if (this._interlaceMethod === InterlaceMethod.ADAM7) {
        this._png.data = decodeInterlaceAdam7({
          data,
          width: this._png.width,
          height: this._png.height,
          channels: this._png.channels,
          depth: this._png.depth
        });
      } else {
        throw new Error(`Interlace method ${this._interlaceMethod} not supported`);
      }
      if (this._hasPalette) {
        this._png.palette = this._palette;
      }
      if (this._hasTransparency) {
        this._png.transparency = this._transparency;
      }
    }
    pushDataToFrame() {
      this._inflator.push(new Uint8Array(0), true);
      const result = this._inflatorResult;
      const lastFrame = this._frames.at(-1);
      if (lastFrame) {
        lastFrame.data = result;
      } else {
        this._frames.push({
          sequenceNumber: 0,
          width: this._png.width,
          height: this._png.height,
          xOffset: 0,
          yOffset: 0,
          delayNumber: 0,
          delayDenominator: 0,
          disposeOp: DisposeOpType.NONE,
          blendOp: BlendOpType.SOURCE,
          data: result
        });
      }
      this._inflator = new Unzlib((chunk, final) => {
        this._chunks.push(chunk);
        if (final) {
          const totalLength = this._chunks.reduce((sum, c) => sum + c.length, 0);
          this._inflatorResult = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk2 of this._chunks) {
            this._inflatorResult.set(chunk2, offset);
            offset += chunk2.length;
          }
          this._chunks = [];
        }
      });
      this._chunks = [];
      this._writingDataChunks = false;
    }
  };
  function checkBitDepth(value) {
    if (value !== 1 && value !== 2 && value !== 4 && value !== 8 && value !== 16) {
      throw new Error(`invalid bit depth: ${value}`);
    }
    return value;
  }

  // node_modules/fast-png/lib/index.js
  function decodePng(data, options) {
    const decoder = new PngDecoder(data, options);
    return decoder.decode();
  }

  // web/src/png-decoder.mjs
  function sampleAt(data, index, depth) {
    const value = data[index];
    return depth === 16 ? value >>> 8 : value;
  }
  function decodePng2(bytes) {
    const decoded = decodePng(bytes);
    const { width, height, channels, depth, data } = decoded;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      const source = pixel * channels;
      const target = pixel * 4;
      if (channels === 1) {
        const gray = sampleAt(data, source, depth);
        rgba[target] = gray;
        rgba[target + 1] = gray;
        rgba[target + 2] = gray;
        rgba[target + 3] = 255;
      } else if (channels === 2) {
        const gray = sampleAt(data, source, depth);
        rgba[target] = gray;
        rgba[target + 1] = gray;
        rgba[target + 2] = gray;
        rgba[target + 3] = sampleAt(data, source + 1, depth);
      } else if (channels === 3) {
        rgba[target] = sampleAt(data, source, depth);
        rgba[target + 1] = sampleAt(data, source + 1, depth);
        rgba[target + 2] = sampleAt(data, source + 2, depth);
        rgba[target + 3] = 255;
      } else if (channels === 4) {
        rgba[target] = sampleAt(data, source, depth);
        rgba[target + 1] = sampleAt(data, source + 1, depth);
        rgba[target + 2] = sampleAt(data, source + 2, depth);
        rgba[target + 3] = sampleAt(data, source + 3, depth);
      } else {
        throw new Error(`Unsupported PNG channel count: ${channels}`);
      }
    }
    return { width, height, data: rgba };
  }
  return __toCommonJS(png_decoder_exports);
})();
