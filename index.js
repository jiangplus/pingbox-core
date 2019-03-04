const path = require('path')
const fs = require('fs')

const mkdirp = require('mkdirp')

const pull = require('pull-stream')
const MRPC = require('muxrpc')
const MultiServer = require('multiserver')

const crypto = require('./src/lib/crypto')
const schema = require('./src/lib/schema')
const Core = require('./src/core')


const manifest = {
  hello: 'async',
  stuff: 'source',
}


class Pingbox extends Core {
  constructor(name, opts={}) {

    name = name || 'default'
    let basedir = path.resolve(opts.basedir || 'data')
    let dir = path.join(basedir, name)
    mkdirp(dir)


    let keys = crypto.loadOrCreateSync(path.join('env', name+'.keyjson'))
    super(name, keys)

    // super(name, opts)

    console.log('started', name, opts)
    this.name = name
    this.basedir = basedir
    this.dir = dir
    this.port = opts.port || keys.port
    this.host = opts.host || keys.host
    this.isServer = opts.server === false ? false : true

    this.clients = []

    if (this.isServer) {
      this.startServer()
    } else {
      this.startClient()
    }
  }

  createHandler() {
    return {
        hello: (cb) => {
          console.log(this)
          cb(null, ('welcome'))
        },
        stuff: () => {
          return pull.values([1, 2, 3, 4, 5])
        },
      }
  }

  startServer() {
    let ms = MultiServer([
      require('multiserver/plugins/ws')({host: 'localhost', port: this.port})
    ])
     let close = ms.server((stream) => {
      let server = MRPC(manifest, manifest) ({
        hello: (req, cb) => {
          cb(null, {pubkey: this.pubkey, host: 'localhost', port: this.port})
          let peer = this.addPeer({pubkey: req.pubkey, host: null, port: req.port})

        },
        stuff: () => {
          return pull.values([1, 2, 3, 4, 5])
        },
      })

      let b = server.createStream()
      pull(b, stream, b)
    })
  }

  getClient(pubkey) {
    if (!pubkey) throw 'pubkey empty'
    return this.clients.find(e => e.pubkey == pubkey || e.name == pubkey)
  }

  doConnect(info) {
    let peer = this.addPeer(info)
    console.log(peer)

    let client = MRPC(manifest, manifest) ({
        hello: (cb) => {
          cb(null, ('welcome'))
        },
        stuff: () => {
          return pull.values([1, 2, 3, 4, 5])
        },
      })

    let a = client.createStream(console.log.bind(console, 'stream is closed'))
    let ms = MultiServer([
      require('multiserver/plugins/ws')({host: 'localhost', port: peer.port})
    ])
    let abort = ms.client('ws://localhost:'+peer.port, (err, stream) => {
      pull(a, stream, a)

      client.pubkey = info.pubkey
      client.name = info.name || null
      console.log('info', info)
      if (info.isTracker) {
        console.log('is tracker')
        client.isTracker = true
      }
      this.clients.push(client) // todo: remove dup

      client.hello({pubkey: this.pubkey, host: this.host, port: this.port}, (err, value) => {
        if(err) throw err
        console.log(value)
        this.emit('welcome', peer)
      })

    })
  }

  startClient() {
    let client = MRPC(manifest, manifest) ()
    this.client = client

    let a = client.createStream(console.log.bind(console, 'stream is closed'))
    let ms = MultiServer([
      require('multiserver/plugins/ws')({host: 'localhost', port: this.port})
    ])
    let abort = ms.client('ws://localhost:'+this.port, (err, stream) => {
      pull(a, stream, a)

      client.hello((err, value) => {
        if(err) throw err
        console.log(value)
        this.emit('handshake')
      })

    })
  }
}



module.exports = Pingbox

function testrpc() {
  let $alice = crypto.loadOrCreateSync('env/alice.keyjson')
  let $bob   = crypto.loadOrCreateSync('env/bob.keyjson')
  let $caddy = crypto.loadOrCreateSync('env/caddy.keyjson')
  let $dan   = crypto.loadOrCreateSync('env/dan.keyjson')

  let alice = new Pingbox('alice')
  let bob = new Pingbox('bob')
  let caddy = new Pingbox('caddy')
  let dan = new Pingbox('dan')

  console.log()
  console.log(bob)

  alice.addContact($alice.pubkey, $caddy.pubkey)
  alice.add_samples('hello')

  bob.addContact($bob.pubkey, $alice.pubkey)
  bob.addContact($bob.pubkey, $caddy.pubkey)
  bob.add_samples('hello')

  caddy.addContact($caddy.pubkey, $alice.pubkey)
  caddy.add_samples('hello')

  dan.add_samples('hello')

  console.log('alice', alice.getMessages())

  bob.doConnect(dan)


  // bob.doConnect(dan).then((resp) => {
  //   return bob.doStreaming(dan.pubkey)
  // }).then((resp) => {
  //   bob.fetchPeer(dan.pubkey)
  // })

}

testrpc()

