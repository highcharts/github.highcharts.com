// Set up a list of functions available for execution.
const listFn = {
  'compileSync': require('./compiler.js').compileSync
}

// Start listening to messages.
process.on('message', (obj) => {
  const result = {}
  const {
    fnName,
    args = []
  } = obj

  // Retrieve the function from the list of available functions.
  const fn = listFn[fnName]
  if (fn) {
    try {
      // Execute the function with the given arguments, and collect the returned value.
      result.value = fn(...args)
    } catch (e) {
      // Function errored, return the error to the parent process.
      result.error = e
    }
  } else {
    // Function was not available, return an error to the parent process.
    result.error = new Error(`${fnName} is not available in fork.js`)
  }

  // Send the result to the parent process.
  process.send(result)

  // Close the process after sending the result.
  process.disconnect()
})
