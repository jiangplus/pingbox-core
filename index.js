const { EventEmitter } = require('events')
const path = require('path')

const pull = require('pull-stream')
const MRPC = require('muxrpc')
const MultiServer = require('multiserver')


const manifest = {
  hello: 'async',
  stuff: 'source',
}

class Pingbox extends EventEmitter {
  constructor(name, opts={}) {
    super()

    console.log('started', name, opts)
    this.name = name || 'default'
    this.basedir = path.resolve(opts.basedir || 'data')
    this.dir = path.join(this.basedir, this.name)
    this.port = opts.port
    this.isServer = !!opts.server

    console.log(this)
    if (this.isServer) {
      this.startServer()
    } else {
      this.startClient()
    }
  }

  startServer() {
    let ms = MultiServer([
      require('multiserver/plugins/ws')({host: 'localhost', port: 2346})
    ])
     let close = ms.server((stream) => {
      let server = MRPC(null, manifest) ({
        hello: (cb) => {
          cb(null, ('welcome'))
        },
        stuff: () => {
          return pull.values([1, 2, 3, 4, 5])
        },
      })

      let b = server.createStream()
      pull(b, stream, b)
    })
  }

  startClient() {
    let client = MRPC(manifest, null) ()
    this.client = client

    let a = client.createStream(console.log.bind(console, 'stream is closed'))
    let ms = MultiServer([
      require('multiserver/plugins/ws')({host: 'localhost', port: 2346})
    ])
    let abort = ms.client('ws://localhost:2346', (err, stream) => {
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


