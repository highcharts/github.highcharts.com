let json = require('../package.json')
const fs = require('fs')
const delimiter = '.'
let arr = json.version.split(delimiter)
let minor = arr.pop()
minor += 1 // Increment the version number.
arr.push(minor)
json.version = arr.join(delimiter)
fs.writeFileSync('../package.json', json)
