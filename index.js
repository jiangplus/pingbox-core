const path = require('path')
const fs = require('fs')

const mkdirp = require('mkdirp')

const pull = require('pull-stream')
const MRPC = require('muxrpc')
const MultiServer = require('multiserver')

const crypto = require('./src/lib/crypto')
const schema = require('./src/lib/schema')
const Core = require('./src/core')

const { pick, arrayPooling, pooling, isEmpty, diffloop } = require('./src/lib/helper')

const timestamp = require('./src/lib/timestamp')
const log = console.log.bind(console)


const manifest = {
  hello: 'async',
  stuff: 'source',
  syncClocks: 'async',
  syncMessages: 'async',
  notifyContact: 'async',
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

  getClient(pubkey) {
    if (!pubkey) throw 'pubkey empty'
    return this.clients.find(e => e.pubkey == pubkey || e.name == pubkey)
  }

  setClient(pubkey, client) {
    let localclient = this.getClient(pubkey)
    if (!localclient) {
      this.clients.push(client)
    }
  }

  requestMessage(client, payload) {
    console.log('requesting', payload)
    setTimeout(() => {
      client.syncMessages(payload, (err, messages) => {
        messages.messages.map(msg => {
          this.commitMessage(msg)
        })
      })
    }, 100)
  }

  startServer() {
    let ms = MultiServer([
      require('multiserver/plugins/ws')({host: 'localhost', port: this.port})
    ])
     let close = ms.server((stream) => {
      let server = MRPC(manifest, manifest) ({
        hello: (req, cb) => {
          let peer = this.addPeer({pubkey: req.pubkey, host: null, port: req.port})
          cb(null, {pubkey: this.pubkey, host: 'localhost', port: this.port})
          server.isServer = true
          server.pubkey = req.pubkey
          this.setClient(server.pubkey, server)
        },
        stuff: () => {
          return pull.values([1, 2, 3, 4, 5])
        },
        syncClocks: (payload, cb) => {
          console.log('receive', payload)

          console.log('in client clocks', this.name, payload)
          let peer = this.getPeer(server.pubkey)
          peer.state_change = timestamp()

          let old_local_latest = peer.local_latest
          peer.local_latest = this.getLocalLatest()
          let seq_range = payload.seqs.map(e => e.pubkey).concat(Object.keys(peer.state))
          // let seqs = this.getSeqs()
          let seqs = this.getSeqs(0, seq_range)
          let popnotes = []

          diffloop(
            pooling(seqs), 
            pooling(payload.seqs), 
            peer.state, 
            (pubkey, [localseq, remoteseq, peerseq]) => {
              if (localseq !== null) {
                if (remoteseq !== null) {
                  if (peerseq === null || peerseq === -1) {
                    server.notifyContact({pubkey: pubkey, seq: localseq}, (err, payload) => {
                      // noop
                    })
                  }

                  peer.state[pubkey] = remoteseq
                }

                if (remoteseq > localseq) {
                  this.requestMessage(server, {peerkey: server.pubkey, pubkey: pubkey, from: (localseq + 1), to: remoteseq})
                }
              }
          })

          this.updatePeer(peer)

          let resp = seqs.map(seq => pick(seq, ['pubkey', 'seq']))
          log('resp', resp, seqs)

          cb(null, {seqs: resp})
        },

        syncMessages: (seq, cb) => {
          let messages
          if (seq.from && seq.to) {
            messages = this.getAccountMessages(seq.pubkey, seq.from, seq.to).map(msg => {
              // msg.content = JSON.parse(msg.content)
              msg = pick(msg, ['key', 'author', 'previous', 'seq', 'timestamp', 'content', 'msgtype', 'sig'])
              // msg.previous = msg.previous || undefined

              console.log('logger', msg)
              return msg
            })
          } else if (seq.key) {
            let message = this.getMessage(seq.key)
            message = pick(message, ['key', 'author', 'previous', 'seq', 'timestamp', 'content', 'msgtype', 'sig'])
            messages = [message]
          }

          cb(null, {messages: messages})
        }
      })

      let b = server.createStream()
      pull(b, stream, b)
    })
  }

  doConnect(info) {
    let peer = this.addPeer(info)
    console.log(peer)

    let client = MRPC(manifest, manifest) ({
        hello: (req, cb) => {
          console.log('req', req)
          cb(null, ('welcome from client'))
        },
        stuff: () => {
          return pull.values([1, 2, 3, 4, 5])
        },
        notifyContact: (req, cb) => {
          // todo: record and send notes
          console.log('notified', req, cb)
          cb('ok')
        }
      })

    let a = client.createStream(console.log.bind(console, 'stream is closed'))
    let ms = MultiServer([
      require('multiserver/plugins/ws')({host: 'localhost', port: peer.port})
    ])
    let abort = ms.client('ws://localhost:'+peer.port, (err, stream) => {
      pull(a, stream, a)

      client.name = info.name || null
      client.pubkey = info.pubkey
      client.isClient = true
      if (info.isTracker) {
        client.isTracker = true
      }
      this.setClient(client.pubkey, client)

      client.hello({pubkey: this.pubkey, host: this.host, port: this.port}, (err, value) => {
        if(err) throw err
        console.log(value)
        this.emit('welcome', peer)
      })

    })

    this.on('welcome', () => {
      console.log('sync clock')
      let old_local_latest = peer.local_latest
      let new_local_latest = this.getLocalLatest()
      peer.local_latest = new_local_latest

      let seq_range = isEmpty(peer.state) ? Object.keys(peer.state) : null
      let seqs = this.getSeqs(old_local_latest, seq_range)
      let payload = {seqs: seqs}
      console.log('payload', payload)

      client.syncClocks(payload, (err, payload) => {
          console.log('in client', this.name, err, payload)
          let peer = this.getPeer(client.pubkey)
          peer.state_change = timestamp()

          let old_local_latest = peer.local_latest
          peer.local_latest = this.getLocalLatest()
          let seq_range = payload.seqs.map(e => e.pubkey).concat(Object.keys(peer.state))
          let seqs = this.getSeqs(0, seq_range)
          let popnotes = []

          diffloop(
            pooling(seqs), 
            pooling(payload.seqs), 
            peer.state, 
            (pubkey, [localseq, remoteseq, peerseq]) => {
              if (localseq !== null) {
                if (remoteseq !== null) {
                  if (peerseq === null || peerseq === -1) {
                    popnotes.push({pubkey: pubkey, seq: localseq})
                  }

                  peer.state[pubkey] = remoteseq
                }

                if (remoteseq > localseq) {
                  this.requestMessage(client, {peerkey: client.pubkey, pubkey: pubkey, from: (localseq + 1), to: remoteseq})
                }
              }
          })

          this.updatePeer(peer)

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

  try { fs.unlinkSync('data/alice/sqlite3.db') } catch (err) { log(err) }
  try { fs.unlinkSync('data/bob/sqlite3.db')   } catch (err) { log(err) }
  try { fs.unlinkSync('data/caddy/sqlite3.db') } catch (err) { log(err) }
  try { fs.unlinkSync('data/dan/sqlite3.db')   } catch (err) { log(err) }

  let $alice = crypto.loadOrCreateSync('env/alice.keyjson')
  let $bob   = crypto.loadOrCreateSync('env/bob.keyjson')
  let $caddy = crypto.loadOrCreateSync('env/caddy.keyjson')
  let $dan   = crypto.loadOrCreateSync('env/dan.keyjson')

  let alice = new Pingbox('alice')
  let bob = new Pingbox('bob')
  let caddy = new Pingbox('caddy')
  let dan = new Pingbox('dan')

  alice.addContact($alice.pubkey, $caddy.pubkey)
  alice.add_samples('hello')

  bob.addContact($bob.pubkey, $alice.pubkey)
  bob.addContact($bob.pubkey, $caddy.pubkey)
  bob.add_samples('hello')

  caddy.addContact($caddy.pubkey, $alice.pubkey)
  caddy.add_samples('hello')

  dan.add_samples('hello')

  console.log('alice', alice.getMessages())

  bob.doConnect(alice)
  
}

testrpc()

