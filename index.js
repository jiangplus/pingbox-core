const path = require('path')
const fs = require('fs')
const { promisify } = require('util')
const timeout = promisify(setTimeout)

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
          console.log('server receive clocks', this.name, payload)
          let peer = this.getPeer(server.pubkey)
          peer.state_change = timestamp()

          let old_local_latest = peer.local_latest
          peer.local_latest = this.getLocalLatest()
          let range = payload.seqs.map(e => e.pubkey).concat(Object.keys(peer.state))
          let seqs = this.getSeqs(0, range)
          let localseqs = pooling(seqs)
          let remoteseqs = pooling(payload.seqs)
          let resp = []

          console.log('local seqs', seqs)

          for (let seq of payload.seqs) {
            let pubkey = seq.pubkey
            let remoteseq = seq.seq
            let localseq = localseqs[pubkey]
            let peerseq = peer.state[pubkey]
            console.log(localseq, remoteseq, peerseq)

            peer.state[pubkey] = remoteseq
            if (localseq !== undefined) {
              resp.push({pubkey: pubkey, seq: localseq})
            }

            if (localseq !== undefined && remoteseq > localseq) {
              this.requestMessage(server, {
                peerkey: server.pubkey, 
                pubkey: pubkey, 
                from: (localseq + 1), 
                to: remoteseq
              })
            }
          }

          this.updatePeer(peer)
          cb(null, {seqs: resp})
        },

        syncMessages: (seq, cb) => {
          let messages
          if (seq.from && seq.to) {
            messages = this.getAccountMessages(seq.pubkey, seq.from, seq.to).map(message => {
              message = pick(message, ['key', 'author', 'previous', 'seq', 'timestamp', 'content', 'msgtype', 'sig'])
              return message
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

  async doConnect(info) {
      let peer = this.addPeer(info)
      console.log('peer', peer)

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
            // console.log('notified', req, cb)
            cb('ok')
          },
          syncMessages: (seq, cb) => {
            let messages
            if (seq.from && seq.to) {
              messages = this.getAccountMessages(seq.pubkey, seq.from, seq.to).map(message => {
                message = pick(message, ['key', 'author', 'previous', 'seq', 'timestamp', 'content', 'msgtype', 'sig'])
                return message
              })
            } else if (seq.key) {
              let message = this.getMessage(seq.key)
              message = pick(message, ['key', 'author', 'previous', 'seq', 'timestamp', 'content', 'msgtype', 'sig'])
              messages = [message]
            }

            cb(null, {messages: messages})
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

          if (client.isTracker) {
            // todo doSyncPeer
          } else {
            this.doSync(peer, client, () => {
            })
          }
        })
      })
  }

  doSync(peer, client, callback) {
    console.log('do sync')
    let old_local_latest = peer.local_latest
    let new_local_latest = this.getLocalLatest()
    peer.local_latest = new_local_latest

    let range = isEmpty(peer.state) ? Object.keys(peer.state) : null
    // let seqs = this.getSeqs(old_local_latest, range)
    let seqs = this.getSeqs(0, range)
    let payload = {seqs: seqs}
    console.log('payload', payload)
    console.log('range', range)

    client.syncClocks(payload, (err, payload) => {
        console.log('in client', this.name, err, payload)
        peer.state_change = timestamp()

        let seqs = this.getSeqs(0)
        let localseqs = pooling(seqs)
        let remoteseqs = pooling(payload.seqs)
        console.log('my seqs', seqs)

        for (let seq of payload.seqs) {
          let pubkey = seq.pubkey
          let remoteseq = seq.seq
          let localseq = localseqs[pubkey]
          let peerseq = peer.state[pubkey]
          console.log(localseq, remoteseq, peerseq)

          peer.state[pubkey] = remoteseq

          if (localseq !== undefined && remoteseq > localseq) {
            this.requestMessage(client, {
              peerkey: client.pubkey, 
              pubkey: pubkey, 
              from: (localseq + 1), 
              to: remoteseq
            })
          }
        }

        this.updatePeer(peer)
        console.log('new peer', peer)
    })

    callback()
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

async function testrpc() {

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
  alice.addContact($alice.pubkey, $bob.pubkey)
  alice.add_samples('hello')

  bob.addContact($bob.pubkey, $alice.pubkey)
  bob.addContact($bob.pubkey, $caddy.pubkey)
  bob.add_samples('hello')

  caddy.addContact($caddy.pubkey, $alice.pubkey)
  caddy.add_samples('hello')

  dan.addContact($dan.pubkey, $alice.pubkey)
  dan.add_samples('hello')


  await bob.doConnect(alice)

  await timeout(1000)

  // console.log('alice', alice.getMessages())

  await alice.doConnect(caddy)
  await timeout(1000)
  // console.log('alice', alice.getMessages())

  alice.add_samples('world')
  await timeout(1000)

  await bob.doConnect(alice)
  await timeout(1000)
  console.log('bob', bob.getMessages())


  alice.add_samples('new world')
  await timeout(2000)
  console.log('---------------')
  console.log('---------------')

  await bob.doConnect(alice)
  await timeout(1000)
  console.log('bob', bob.getMessages())


  
}

testrpc()

