const listFn = {
  'compileSync': require('./compiler.js').compileSync
}
process.on('message', (obj) => {
  const result = {}
  const {
    fnName,
    args = []
  } = obj
  const fn = listFn[fnName]
  if (fn) {
    try {
      result.value = fn(...args)
    } catch (e) {
      result.error = e
    }
  } else {
    result.error = new Error(`${fnName} is not available in fork.js`)
  }
  process.send(result)
})
