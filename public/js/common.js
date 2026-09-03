// common.js - runs on every page
document.addEventListener('DOMContentLoaded', () => {
  const toggle = document.querySelector('.nav-toggle');
  const nav = document.querySelector('.main-nav');
  if (toggle && nav) {
    toggle.addEventListener('click', () => nav.classList.toggle('open'));
  }

  // Highlight the current page in the nav
  const current = window.location.pathname.replace(/\/$/, '') || '/index.html';
  document.querySelectorAll('.main-nav a').forEach((a) => {
    const href = a.getAttribute('href');
    if (href === current || (current === '/' && href === '/index.html') || (current === '/index.html' && href === '/')) {
      a.classList.add('active');
    }
  });
});

// Small helper used across pages for fetch + JSON
async function apiRequest(url, options = {}) {
  const opts = { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } };
  const res = await fetch(url, opts);
  let body = {};
  try { body = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) {
    const err = new Error(body.error || `Request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return body;
}
