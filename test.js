var krpc = require('./')
var tape = require('tape')

wrapTest(tape, 'query + reply', function (t, ipv6) {
  var server = krpc({ipv6: ipv6})

  server.on('query', function (query, peer) {
    t.same(query.q.toString(), 'echo')
    t.same(query.a.hello, 42)
    server.response(peer, query, {hello: 42})
  })

  server.bind(0, function () {
    var id = new Buffer('aaaabbbbccccddddeeeeaaaabbbbccccddddeeee', 'hex')
    var client = krpc({
      ipv6: ipv6,
      nodes: [localHost(ipv6) + ':' + server.address().port]
    })

    client.closest(id, {q: 'echo', a: {hello: 42}}, onreply, function (err, n) {
      server.destroy()
      client.destroy()
      t.error(err)
      t.same(n, 1)
      t.end()
    })

    function onreply (message, node) {
      t.same(node.address, localHost(ipv6, true))
      t.same(node.port, server.address().port)
      t.same(message.r.hello, 42)
    }
  })
})

wrapTest(tape, 'query + closest', function (t, ipv6) {
  var server = krpc({ipv6: ipv6})
  var other = krpc({ipv6: ipv6})
  var visitedOther = false

  other.on('query', function (query, peer) {
    visitedOther = true
    t.same(query.q.toString(), 'echo')
    t.same(query.a.hello, 42)
    server.response(peer, query, {hello: 42})
  })

  server.on('query', function (query, peer) {
    t.same(query.q.toString(), 'echo')
    t.same(query.a.hello, 42)
    server.response(peer, query, {hello: 42}, [{host: localHost(ipv6, true), port: other.address().port, id: other.id}])
  })

  other.bind(0, function () {
    server.bind(0, function () {
      var replies = 2
      var id = new Buffer('aaaabbbbccccddddeeeeaaaabbbbccccddddeeee', 'hex')
      var client = krpc({
        ipv6: ipv6,
        nodes: [localHost(ipv6) + ':' + server.address().port]
      })

      client.closest(id, {q: 'echo', a: {hello: 42}}, onreply, function (err, n) {
        server.destroy()
        client.destroy()
        other.destroy()
        t.error(err)
        t.same(replies, 0)
        t.same(n, 2)
        t.ok(visitedOther)
        t.end()
      })

      function onreply (message, node) {
        replies--
        t.same(message.r.hello, 42)
      }
    })
  })
})

function localHost (ipv6, plainIpv6) {
  if (ipv6) {
    if (!plainIpv6) {
      return '[::1]'
    }
    return '::1'
  }
  return '127.0.0.1'
}

function wrapTest (test, str, func) {
  test('ipv4 ' + str, function (t) {
    func(t, false)
    if (t._plan) {
      t.plan(t._plan + 1)
    }

    t.test('ipv6 ' + str, function (newT) {
      func(newT, true)
    })
  })
}
