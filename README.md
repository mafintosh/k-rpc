# k-rpc

Low-level implementation of the k-rpc protocol used the BitTorrent DHT.

```
npm install k-rpc
```

Read [BEP 5](http://www.bittorrent.org/beps/bep_0005.html) and [BEP 44](http://www.bittorrent.org/beps/bep_0044.html) for more background info.

## Usage

``` js
var krpc = require('k-rpc')
var rpc = krpc()

var target = new Buffer('aaaabbbbccccddddeeeeffffaaaabbbbccccdddd', 'hex')

// query the BitTorrent DHT to find nodes near the target buffer
rpc.closest(target, {q: 'get_peers', a: {info_hash: target}}, onreply, done)

function onreply (message, node) {
  console.log('visited peer', message, node)
}

function done () {
  console.log('(done)')
}
```

## API

#### `var rpc = krpc([options])`

Create a new rpc instance. Options include

``` js
{
  // per peer query timeout defaults to 2s
  timeout: 2000,
  // an array of bootstrap nodes. defaults to the BitTorrent bootstrap nodes
  nodes: ['example.com:6881'],
  // how many concurrent queries should be made. defaults to 16
  concurrency: 16,
  // how big should be routing buckets be. defaults to 20.
  k: 20,
  // the local node id. defaults to 20 random bytes
  id: Buffer(...)
}
```

#### `rpc.id`

Buffer containing the local node id.

#### `rpc.populate(query, [callback])`

Populate the internal routing table with nodes discovered by looking for other peers close to our own local node id using the specified query. The internal routing table will be used for subsequent closest queries to take load of the bootstrap nodes.

``` js
// send a find_node query
rpc.populate(rpc.id, {q: 'find_node', a: {id: rpc.id, target: rpc.id}}, function () {
  console.log('internal routing table fully populated')
})
```

You should call this method as soon as possible to spread out query load in the DHT.
Callback is called with `(err, numberOfReplies)`.

#### `rpc.closest(target, query, onreply, [callback])`

Find peers close the specified target buffer whilst sending the specified query. `onreply` will be called with `(reply, node)` for every reply received and the callback is called with `(err, totalNumberOfReplies)`.

``` js
// find peers sharing a torrent info_hash
rpc.closest(infoHash, {q: 'get_peers', a: {id: rpc.id: info_hash: infoHash}}, onreply, function () {
  console.log('no more peers to be found')
})

function onreply (message, node) {
  if (message.r && message.r.values) console.log('received peers')
}
```

If a closest query is being executed while a population request in being run the closest query will take priority.

#### `rpc.query(node, query, callback)`

Query a single node. If the node has a token it is set as `a.token` in the query automatically.
Callback is called with `(err, reply)`.

#### `rpc.queryAll(nodes, query, onreply, callback)`

Query multiple nodes with the same query. `query.a.token` will be set as the corresponding nodes token when querying.
Callback is called with `(err, numberOfReplies)` and `onreply` will be caleld with `(reply, node)` as the nodes reply.

#### `rpc.destroy()`

Destroy the underlying rpc socket.

#### `rpc.on('query', query, node)`

Emitted when a query is received.

#### `rpc.response(node, query, response, [callback])`

Send a response to a node for a specific query.

#### `rpc.error(node, query, error, [callback])`

Send an error response for a query.

#### `rpc.add(node)`

Explicitly add a node to the internal routing table. A node must look like this `{host: host, port: port, id: nodeId}`.
Calling the populate method will populate the internal routing table for you.

#### `rpc.remove(node)`

Explicitly remove a node from the internal routing table

## License

MIT
