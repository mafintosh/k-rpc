const KRPC = require('./')
const tape = require('tape')
const Buffer = require('safe-buffer').Buffer

tape('query + reply', t => {
  const server = new KRPC()

  server.on('query', (query, peer) => {
    t.same(query.q.toString(), 'echo')
    t.same(query.a.hello, 42)
    server.response(peer, query, { hello: 42 })
  })

  server.bind(0, () => {
    const id = Buffer.from('aaaabbbbccccddddeeeeaaaabbbbccccddddeeee', 'hex')
    const client = new KRPC({
      nodes: [`localhost:${server.address().port}`]
    })

    client.closest(id, { q: 'echo', a: { hello: 42 } }, onreply, (err, n) => {
      server.destroy()
      client.destroy()
      t.error(err)
      t.same(n, 1)
      t.end()
    })

    function onreply (message, node) {
      t.same(node.address, '127.0.0.1')
      t.same(node.port, server.address().port)
      t.same(message.r.hello, 42)
    }
  })
})

tape('query + closest', t => {
  const server = new KRPC()
  const other = new KRPC()
  let visitedOther = false

  other.on('query', (query, peer) => {
    visitedOther = true
    t.same(query.q.toString(), 'echo')
    t.same(query.a.hello, 42)
    server.response(peer, query, { hello: 42 })
  })

  server.on('query', (query, peer) => {
    t.same(query.q.toString(), 'echo')
    t.same(query.a.hello, 42)
    server.response(peer, query, { hello: 42 }, [{ host: '127.0.0.1', port: other.address().port, id: other.id }])
  })

  other.bind(0, () => {
    server.bind(0, () => {
      let replies = 2
      const id = Buffer.from('aaaabbbbccccddddeeeeaaaabbbbccccddddeeee', 'hex')
      const client = new KRPC({
        nodes: [`localhost:${server.address().port}`, `localhost:${other.address().port}`]
      })

      client.closest(id, { q: 'echo', a: { hello: 42 } }, onreply, (err, n) => {
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
