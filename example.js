import KRPC from './index.js'
const rpc = new KRPC()

const target = Buffer.from('aaaabbbbccccddddeeeeffffaaaabbbbccccdddd', 'hex')

rpc.on('query', function (query, peer) {
  // console.log(query, peer)
})

const then = Date.now()

rpc.populate(rpc.id, { q: 'find_node', a: { id: rpc.id, target: rpc.id } }, function () {
  console.log('(populated)', Date.now() - then)
})

rpc.closest(target, { q: 'get_peers', a: { info_hash: target } }, visit, function (_, n) {
  console.log('(closest)', Date.now() - then, n)
})

function visit (res, peer) {
  const peers = res.r.values ? parsePeers(res.r.values) : []
  if (peers.length) console.log('count peers:', peers.length)
}

function parsePeers (buf) {
  const peers = []

  try {
    for (let i = 0; i < buf.length; i++) {
      const view = new DataView(buf[i].buffer)
      const port = view.getUint16(4)
      if (!port) continue
      peers.push({
        host: parseIp(buf[i], 0),
        port
      })
    }
  } catch (err) {
    // do nothing
  }

  return peers
}

function parseIp (buf, offset) {
  return buf[offset++] + '.' + buf[offset++] + '.' + buf[offset++] + '.' + buf[offset++]
}
