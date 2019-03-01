const { EventEmitter } = require('events')
const path = require('path')
const fs = require('fs')

const db = require('better-sqlite3')
const migration = fs.readFileSync(path.resolve('./src/schema.sql'), 'utf8')

class Core extends EventEmitter {
  constructor(name, opts={}) {
    super()

    this.name = name
    this.db = db(path.join('data', name, '/sqlite3.db'))
    this.db.exec(migration)
  }
}

module.exports = Core
