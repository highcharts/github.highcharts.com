'use strict'

const panel = document.querySelector('#login-panel')
const heading = document.querySelector('#login-heading')
const form = document.querySelector('#login-form')
const token = document.querySelector('#token')
const error = document.querySelector('#login-error')
const submit = document.querySelector('#login-submit')

panel.hidden = false
heading.focus()

form.addEventListener('submit', async event => {
  event.preventDefault()
  error.textContent = ''
  token.removeAttribute('aria-invalid')
  submit.disabled = true

  try {
    const response = await fetch('/_ops/api/v1/session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: token.value })
    })
    token.value = ''
    if (!response.ok) throw new Error('Authentication failed')
    window.location.replace('/_ops/')
  } catch (failure) {
    token.value = ''
    error.textContent = 'Sign-in failed. Check the token or try again later.'
    token.setAttribute('aria-invalid', 'true')
    token.focus()
  } finally {
    submit.disabled = false
  }
})
