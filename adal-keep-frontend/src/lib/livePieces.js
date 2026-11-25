// The pieces of a live stream (backend services/liveStream.js). No imports: tested in Node.
/** The pieces of the stream, as they come: feed(Uint8Array) → on(kind, Uint8Array). */
export function pieces(on) {
  let buf = new Uint8Array(0)
  return (chunk) => {
    const b = new Uint8Array(buf.length + chunk.length)
    b.set(buf); b.set(chunk, buf.length)
    let o = 0
    const view = new DataView(b.buffer)
    while (b.length - o >= 5) {
      const n = view.getUint32(o)
      if (n > 30e6) throw new Error('not a live stream')
      if (b.length - o - 5 < n) break
      on(String.fromCharCode(b[o + 4]), b.subarray(o + 5, o + 5 + n))
      o += 5 + n
    }
    buf = b.slice(o)
  }
}
