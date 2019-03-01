const sodium = require('chloride')
const bs58 = require('bs58')
let isBuffer = Buffer.isBuffer

function isObject (o) {
  return 'object' === typeof o
}

function isFunction (f) {
  return 'function' === typeof f
}

function isString(s) {
  return 'string' === typeof s
}


function toBuffer (buf) {
  if(buf == null) return buf
  if(Buffer.isBuffer(buf)) return buf
  let start = (hasSigil(buf)) ? 1 : 0
  return bs58.decode(buf.substring(start, buf.length))
}

function sha256 (data, enc) {
  data = (
    'string' === typeof data && enc == null
  ? new Buffer.from(data, 'binary')
  : new Buffer.from(data, enc)
  )
  return sodium.crypto_hash_sha256(data)
}

function sha256bs58 (data, enc) {
  return bs58.encode(sha256(data, enc))
}

function sha256check (hash, data, enc) {
  hash = toBuffer(hash)
  data = isBuffer(data) ? data : Buffer.from(data)
  return hash.compare(sodium.crypto_hash_sha256(data)) === 0
}

function hasSigil (s) {
  return /^(@|%|&)/.test(s)
}

function randombytes (n) {
  let buf
  sodium.randombytes(buf = Buffer.alloc(n))
  return buf
}

function generate (seed) {
  if(!seed) sodium.randombytes(seed = Buffer.alloc(32))

  let keys = seed ? sodium.crypto_sign_seed_keypair(seed) 
                  : sodium.crypto_sign_keypair()
  return {
    curve: 'ed25519',
    pubkey: keys.publicKey,

    //so that this works with either sodium
    //or libsodium-wrappers (in browser)
    prvkey: keys.privateKey || keys.secretKey
  }
}

function sign (privateKey, message) {
  privateKey = toBuffer(privateKey.prvkey || privateKey)
  
  if(isString(message))
    message = Buffer.from(message)
  if(!isBuffer(message))
    throw new Error('message should be buffer')


  return sodium.crypto_sign_detached(message, privateKey)
}

function verify (publicKey, sig, message) {
  if(isObject(sig) && !isBuffer(sig))
    throw new Error('signature should be base58 string')

  publicKey = toBuffer(publicKey.pubkey || publicKey)
  sig = toBuffer(sig)
  message = isBuffer(message) ? message : Buffer.from(message)


  return sodium.crypto_sign_verify_detached(sig, message, publicKey)
}

// load keypair from disk

const fs         = require('fs')
const path       = require('path')
const mkdirp     = require('mkdirp')

function stringifyKeys (keys) {
  return JSON.stringify({
    curve: keys.curve,
    pubkey: bs58.encode(keys.pubkey),
    prvkey: bs58.encode(keys.prvkey),
  }, null, 2)
}

function parseKeys (keyfile) {
  let keys = JSON.parse(keyfile)
  // keys.pubkey = bs58.decode(keys.pubkey)
  // keys.prvkey = bs58.decode(keys.prvkey)
  return keys
}

function loadOrCreateSync (filename) {
  try {
    return parseKeys(fs.readFileSync(filename, 'ascii'))
  } catch (err) {
    let keys = generate()
    let keyfile = stringifyKeys(keys)
    mkdirp.sync(path.dirname(filename))
    fs.writeFileSync(filename, keyfile)
    return keys
  }
}


module.exports = {
  toBuffer,
  sha256,
  sha256bs58,
  sha256check,
  hasSigil,
  randombytes,
  generate,
  sign,
  verify,
  stringifyKeys,
  parseKeys,
  loadOrCreateSync,
}

