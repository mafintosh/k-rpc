var krpc = require('./')
var tape = require('tape')

function genericQuery (t, ipv6) {
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
      nodes: ['localhost:' + server.address().port]
    })

    client.closest(id, {q: 'echo', a: {hello: 42}}, onreply, function (err, n) {
      server.destroy()
      client.destroy()
      t.error(err)
      t.same(n, 1)
      t.end()
    })

    function onreply (message, node) {
      t.same(node.address, ipv6 ? '::1' : '127.0.0.1')
      t.same(node.port, server.address().port)
      t.same(message.r.hello, 42)
    }
  })
}

tape('ipv4 query + reply', function (t) {
  genericQuery(t, false)
})

tape('ipv6 query + reply', function (t) {
  genericQuery(t, true)
})

function genericClosest (t, ipv6) {
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
    server.response(peer, query, {hello: 42}, [{host: ipv6 ? '::1' : '127.0.0.1', port: other.address().port, id: other.id}])
  })

  other.bind(0, function () {
    server.bind(0, function () {
      var replies = 2
      var id = new Buffer('aaaabbbbccccddddeeeeaaaabbbbccccddddeeee', 'hex')
      var client = krpc({
        ipv6: ipv6,
        nodes: ['localhost:' + server.address().port]
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
}

tape('ipv4 query + closest', function (t) {
  genericClosest(t, false)
})

tape('ipv6 query + closest', function (t) {
  genericClosest(t, true)
})
