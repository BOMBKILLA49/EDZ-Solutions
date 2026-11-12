const zlib = require("zlib");

// Minimal ZIP writer (files stored as-is, no compression: they're JPEGs already).
// Used for the "all guest cards" download in /admin.
const DOS_DATE = (1 << 5) | 1; // 1980-01-01, the earliest date ZIP can hold

// Streams entries one at a time (add() returns the bytes to send now) so a big download
// starts right away instead of waiting for every file to be built.
class ZipWriter {
  constructor() {
    this.central = [];
    this.offset = 0;
  }

  add(fileName, data) {
    const name = Buffer.from(fileName, "utf8");
    const crc = zlib.crc32(data);
    const size = data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // file names are UTF-8
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // version made by
    entry.writeUInt16LE(20, 6); // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(size, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(this.offset, 42);
    this.central.push(entry, name);

    this.offset += local.length + name.length + size;
    return Buffer.concat([local, name, data]);
  }

  finish() {
    const dir = Buffer.concat(this.central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(this.central.length / 2, 8);
    end.writeUInt16LE(this.central.length / 2, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(this.offset, 16);
    return Buffer.concat([dir, end]);
  }
}

module.exports = { ZipWriter };
