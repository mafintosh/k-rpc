var socket = require('k-rpc-socket')
var KBucket = require('k-bucket')
var equals = require('buffer-equals')
var crypto = require('crypto')
var events = require('events')
var util = require('util')

var K = 20
var MAX_CONCURRENCY = 16
var BOOTSTRAP_NODES = [
  {host: 'router.bittorrent.com', port: 6881},
  {host: 'router.utorrent.com', port: 6881},
  {host: 'dht.transmissionbt.com', port: 6881}
]

module.exports = RPC

function RPC (opts) {
  if (!(this instanceof RPC)) return new RPC(opts)
  if (!opts) opts = {}

  var self = this

  this.id = opts.id || crypto.randomBytes(20)
  this.socket = opts.socket || socket(opts)
  this.nodes = (opts.nodes || BOOTSTRAP_NODES).map(parsePeer)
  this.concurrency = opts.concurrency || MAX_CONCURRENCY
  this.k = opts.k || K

  this.pending = []
  this.table = null

  this.socket.on('query', onquery)
  this.socket.on('warning', onwarning)
  this.socket.on('error', onerror)
  this.socket.on('update', onupdate)

  events.EventEmitter.call(this)
  this.clear()

  function onupdate () {
    while (self.pending.length && self.socket.inflight < self.concurrency) {
      var next = self.pending.shift()
      self.socket.query(next[0], next[1], next[2])
    }
  }

  function onerror (err) {
    self.emit('error', err)
  }

  function onwarning (err) {
    self.emit('warning', err)
  }

  function onquery (query, peer) {
    self.emit('query', query, peer)
  }
}

util.inherits(RPC, events.EventEmitter)

RPC.prototype.response = function (node, query, response, nodes, cb) {
  if (typeof nodes === 'function') {
    cb = nodes
    nodes = null
  }

  response.id = this.id
  if (nodes) response.nodes = encodeNodes(nodes)
  this.socket.response(node, query, response, cb)
}

RPC.prototype.error = function (node, query, error, cb) {
  this.socket.error(node, query, error, cb)
}

RPC.prototype.bind = function (port, cb) {
  this.socket.bind(port, cb)
}

RPC.prototype.address = function () {
  return this.socket.address()
}

RPC.prototype.query = function (node, message, cb) {
  if (!message.a) message.a = {}
  message.a.id = this.id
  message.a.token = node.token

  this._query(node, message, cb)
}

RPC.prototype.queryAll = function (nodes, message, visit, cb) {
  if (!message.a) message.a = {}
  message.a.id = this.id

  var stop = false
  var missing = nodes.length
  var hits = 0

  if (!missing) return cb(new Error('All queries failed'), 0)

  for (var i = 0; i < nodes.length; i++) {
    if (message.a) message.a.token = nodes[i].token
    this._query(nodes[i], message, done)
  }

  function done (err, res, peer) {
    if (!err) hits++
    if (!err && !stop) {
      if (visit && visit(res, peer) === false) stop = true
    }
    if (!--missing) cb(hits ? null : new Error('All queries failed'), hits)
  }
}

RPC.prototype._query = function (node, message, cb) {
  if (this.socket.inflight >= this.concurrency) {
    this.pending.push([node, message, cb])
  } else {
    this.socket.query(node, message, cb)
  }
}

RPC.prototype.destroy = function () {
  this.socket.destroy()
}

RPC.prototype.clear = function () {
  var self = this

  this.table = new KBucket({
    localNodeId: this.id,
    numberOfNodesPerKBucket: this.k,
    numberOfNodesToPing: this.concurrency
  })

  this.table.on('ping', onping)

  function onping (older, newer) {
    self.emit('ping', older, newer)
  }
}

RPC.prototype.populate = function (target, message, cb) {
  this._closest(target, message, true, null, cb)
}

RPC.prototype.closest = function (target, message, visit, cb) {
  this._closest(target, message, false, visit, cb)
}

RPC.prototype._closest = function (target, message, background, visit, cb) {
  if (!cb) cb = noop

  var self = this
  var count = 0
  var queried = {}
  var pending = 0
  var once = true
  var stop = false

  if (!message.a) message.a = {}
  message.a.id = this.id

  var table = new KBucket({
    localNodeId: target,
    numberOfNodesPerKBucket: this.k,
    numberOfNodesToPing: this.concurrency
  })

  var evt = background ? 'postupdate' : 'update'
  this.socket.on(evt, kick)
  kick()

  function kick () {
    if (self.socket.inflight >= self.concurrency) return

    var otherInflight = self.socket.inflight - pending
    if (background && self.socket.inflight >= (self.concurrency / 2) | 0 && otherInflight) return

    var closest = table.closest({id: target}, self.k)
    if (closest.length < self.nodes.length) {
      closest = self.table.closest({id: target}, self.k)
      if (closest.length < self.nodes.length) bootstrap()
    }

    for (var i = 0; i < closest.length; i++) {
      if (stop) break
      if (self.socket.inflight >= self.concurrency) return

      var peer = closest[i]
      var id = peer.host + ':' + peer.port
      if (queried[id]) continue
      queried[id] = true

      pending++
      self.socket.query(peer, message, done)
    }

    if (!pending) {
      self.socket.removeListener(evt, kick)
      cb(null, count)
    }
  }

  function bootstrap () {
    if (!once) return
    once = false

    self.nodes.forEach(function (peer) {
      pending++
      self.socket.query(peer, message, done)
    })
  }

  function done (err, res, peer) {
    pending--
    if (peer) queried[peer.address + ':' + peer.port] = true // need this for bootstrap nodes

    var r = res && res.r
    if (!r) return

    if (peer && peer.id && self.table.get(peer.id)) {
      if (err && err.code === 'ETIMEDOUT') self.table.remove(peer)
      else if (!err) self.table.add(peer)
    }

    if (!err && r.id) {
      var node = {
        id: r.id,
        port: peer.port,
        host: peer.host || peer.address,
        distance: 0
      }

      count++
      add(node)
      if (background) self.table.add(node)
    }

    var nodes = r.nodes ? parseNodes(r.nodes) : []
    for (var i = 0; i < nodes.length; i++) add(nodes[i])

    if (visit && visit(res, peer) === false) stop = true

    kick()
  }

  function add (node) {
    if (equals(node.id, self.id)) return
    table.add(node)
  }
}

function encodeNodes (nodes) {
  var buf = new Buffer(nodes.length * 26)
  var ptr = 0

  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i]
    if (!node.id) continue
    node.id.copy(buf, ptr)
    ptr += 20
    var ip = (node.host || node.address).split('.')
    for (var j = 0; j < ip.length; j++) buf[ptr++] = parseInt(ip[j] || 0, 10)
    buf.writeUInt16BE(node.port, ptr)
    ptr += 2
  }

  if (ptr === buf.length) return buf
  return buf.slice(0, ptr)
}

function parseNodes (buf) {
  var contacts = []

  try {
    for (var i = 0; i < buf.length; i += 26) {
      var port = buf.readUInt16BE(i + 24)
      if (!port) continue
      contacts.push({
        id: buf.slice(i, i + 20),
        host: parseIp(buf, i + 20),
        port: port,
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
  return buf[offset++] + '.' + buf[offset++] + '.' + buf[offset++] + '.' + buf[offset++]
}

function parsePeer (peer) {
  if (typeof peer === 'string') return {host: peer.split(':')[0], port: Number(peer.split(':')[1])}
  return peer
}

function noop () {}
