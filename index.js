const { Buffer } = require('safe-buffer')
const equals = require('buffer-equals')
const EventEmitter = require('events')
const KBucket = require('k-bucket')
const randombytes = require('randombytes')
const socket = require('k-rpc-socket')

const K = 20
const MAX_CONCURRENCY = 16
const BOOTSTRAP_NODES = [
  { host: 'router.bittorrent.com', port: 6881 },
  { host: 'router.utorrent.com', port: 6881 },
  { host: 'dht.transmissionbt.com', port: 6881 }
]

class RPC extends EventEmitter {
  constructor (opts = {}) {
    super()

    const self = this

    this._idLength = opts.idLength || 20
    this.id = toBuffer(opts.id || opts.nodeId || randombytes(this._idLength))
    this.socket = opts.krpcSocket || socket(opts)
    this.bootstrap = toBootstrapArray(opts.nodes || opts.bootstrap)
    this.concurrency = opts.concurrency || MAX_CONCURRENCY
    this.backgroundConcurrency = opts.backgroundConcurrency || (this.concurrency / 4) | 0
    this.k = opts.k || K
    this.destroyed = false

    this.pending = []
    this.nodes = null

    this.socket.setMaxListeners(0)
    this.socket.on('query', onquery)
    this.socket.on('response', onresponse)
    this.socket.on('warning', onwarning)
    this.socket.on('error', onerror)
    this.socket.on('update', onupdate)
    this.socket.on('listening', onlistening)

    this.clear()

    function onupdate () {
      while (self.pending.length && self.socket.inflight < self.concurrency) {
        const next = self.pending.shift()
        self.query(next[0], next[1], next[2])
      }
    }

    function onerror (err) {
      self.emit('error', err)
    }

    function onlistening () {
      self.emit('listening')
    }

    function onwarning (err) {
      self.emit('warning', err)
    }

    function onquery (query, peer) {
      addNode(query.a, peer)
      self.emit('query', query, peer)
    }

    function onresponse (reply, peer) {
      addNode(reply.r, peer)
    }

    function addNode (data, peer) {
      if (data && isNodeId(data.id, self._idLength) && !equals(data.id, self.id)) {
        const old = self.nodes.get(data.id)
        if (old) {
          old.seen = Date.now()
          return
        }
        self._addNode({
          id: data.id,
          host: peer.address || peer.host,
          port: peer.port,
          distance: 0,
          seen: Date.now()
        })
      }
    }
  }

  response (node, query, response, nodes, cb) {
    if (typeof nodes === 'function') {
      cb = nodes
      nodes = null
    }

    if (!response.id) response.id = this.id
    if (nodes) response.nodes = encodeNodes(nodes, this._idLength)
    this.socket.response(node, query, response, cb)
  }

  error (node, query, error, cb) {
    this.socket.error(node, query, error, cb)
  }

  // bind([port], [address], [callback])
  bind (...args) {
    this.socket.bind(...args)
  }

  address () {
    return this.socket.address()
  }

  queryAll (nodes, message, visit, cb) {
    if (!message.a) message.a = {}
    if (!message.a.id) message.a.id = this.id

    let stop = false
    let missing = nodes.length
    let hits = 0
    let error = null

    if (!missing) return cb(new Error('No nodes to query'), 0)

    for (const node of nodes) {
      this.query(node, message, done)
    }

    function done (err, res, peer) {
      if (!err) hits++
      else if (err.code >= 300 && err.code < 400) error = err
      if (!err && !stop) {
        if (visit && visit(res, peer) === false) stop = true
      }
      if (!--missing) cb(hits ? null : error || new Error('All queries failed'), hits)
    }
  }

  query (node, message, cb) {
    if (this.socket.inflight >= this.concurrency) {
      this.pending.push([node, message, cb])
    } else {
      if (!message.a) message.a = {}
      if (!message.a.id) message.a.id = this.id
      if (node.token) message.a.token = node.token
      this.socket.query(node, message, cb)
    }
  }

  destroy (cb) {
    this.destroyed = true
    this.socket.destroy(cb)
  }

  clear () {
    const self = this

    this.nodes = new KBucket({
      localNodeId: this.id,
      numberOfNodesPerKBucket: this.k,
      numberOfNodesToPing: this.concurrency
    })

    this.nodes.on('ping', onping)

    function onping (older, newer) {
      self.emit('ping', older, function swap (deadNode) {
        if (!deadNode) return
        if (deadNode.id) self.nodes.remove(deadNode.id)
        self._addNode(newer)
      })
    }
  }

  populate (target, message, cb) {
    this._closest(target, message, true, null, cb)
  }

  closest (target, message, visit, cb) {
    this._closest(target, message, false, visit, cb)
  }

  _addNode (node) {
    const old = this.nodes.get(node.id)
    this.nodes.add(node)
    if (!old) this.emit('node', node)
  }

  _closest (target, message, background, visit, cb) {
    if (!cb) cb = noop

    const self = this
    let count = 0
    const queried = {}
    let pending = 0
    let once = true
    let stop = false

    if (!message.a) message.a = {}
    if (!message.a.id) message.a.id = this.id

    const table = new KBucket({
      localNodeId: target,
      numberOfNodesPerKBucket: this.k,
      numberOfNodesToPing: this.concurrency
    })

    const evt = background ? 'postupdate' : 'update'
    this.socket.on(evt, kick)
    kick()

    function kick () {
      if (self.destroyed || self.socket.inflight >= self.concurrency) return

      const otherInflight = self.pending.length + self.socket.inflight - pending
      if (background && self.socket.inflight >= self.backgroundConcurrency && otherInflight) return

      let closest = table.closest(target, self.k)
      if (!closest.length || closest.length < self.bootstrap.length) {
        closest = self.nodes.closest(target, self.k)
        if (!closest.length || closest.length < self.bootstrap.length) bootstrap()
      }

      for (const peer of closest) {
        if (stop) break
        if (self.socket.inflight >= self.concurrency) return

        const id = `${peer.host}:${peer.port}`
        if (queried[id]) continue
        queried[id] = true

        pending++
        self.socket.query(peer, message, afterQuery)
      }

      if (!pending) {
        self.socket.removeListener(evt, kick)
        process.nextTick(done)
      }
    }

    function done () {
      cb(null, count)
    }

    function bootstrap () {
      if (!once) return
      once = false
      self.bootstrap.forEach(peer => {
        pending++
        self.socket.query(peer, message, afterQuery)
      })
    }

    function afterQuery (err, res, peer) {
      pending--
      if (peer) queried[`${peer.address || peer.host}:${peer.port}`] = true // need this for bootstrap nodes

      if (peer && peer.id && self.nodes.get(peer.id)) {
        if (err && (err.code === 'EUNEXPECTEDNODE' || err.code === 'ETIMEDOUT')) {
          self.nodes.remove(peer.id)
        }
      }

      const r = res && res.r
      if (!r) return kick()

      if (!err && isNodeId(r.id, self._idLength)) {
        count++
        add({
          id: r.id,
          port: peer.port,
          host: peer.host || peer.address,
          distance: 0
        })
      }

      const nodes = r.nodes ? parseNodes(r.nodes, self._idLength) : []
      for (const node of nodes) add(node)

      if (visit && visit(res, peer) === false) stop = true

      kick()
    }

    function add (node) {
      if (equals(node.id, self.id)) return
      table.add(node)
    }
  }
}

function toBootstrapArray (val) {
  if (val === false) return []
  if (val === true) return BOOTSTRAP_NODES
  return [].concat(val || BOOTSTRAP_NODES).map(parsePeer)
}

function isNodeId (id, idLength) {
  return id && Buffer.isBuffer(id) && id.length === idLength
}

function encodeNodes (nodes, idLength) {
  const buf = Buffer.allocUnsafe(nodes.length * (idLength + 6))
  let ptr = 0

  for (const node of nodes) {
    if (!isNodeId(node.id, idLength)) continue
    node.id.copy(buf, ptr)
    ptr += idLength
    const ip = (node.host || node.address).split('.')
    for (let j = 0; j < 4; j++) buf[ptr++] = parseInt(ip[j] || 0, 10)
    buf.writeUInt16BE(node.port, ptr)
    ptr += 2
  }

  if (ptr === buf.length) return buf
  return buf.slice(0, ptr)
}

function parseNodes (buf, idLength) {
  const contacts = []

  try {
    for (let i = 0; i < buf.length; i += (idLength + 6)) {
      const port = buf.readUInt16BE(i + (idLength + 4))
      if (!port) continue
      contacts.push({
        id: buf.slice(i, i + idLength),
        host: parseIp(buf, i + idLength),
        port,
        distance: 0,
        token: null
      })
    }
  } catch (err) {
    // do nothing
  }

  return contacts
}

function parseIp (buf, offset) {
  return `${buf[offset++]}.${buf[offset++]}.${buf[offset++]}.${buf[offset++]}`
}

function parsePeer (peer) {
  if (typeof peer === 'string') return { host: peer.split(':')[0], port: Number(peer.split(':')[1]) }
  return peer
}

function noop () {}

function toBuffer (str) {
  if (Buffer.isBuffer(str)) return str
  if (ArrayBuffer.isView(str)) return Buffer.from(str.buffer, str.byteOffset, str.byteLength)
  if (typeof str === 'string') return Buffer.from(str, 'hex')
  throw new Error('Pass a buffer or a string')
}

module.exports = RPC
