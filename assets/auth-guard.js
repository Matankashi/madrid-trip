// Include on every page that requires a signed-in user. Redirects to
// login.html if nobody is signed in; otherwise reveals the page (the
// <body> starts with inline visibility:hidden to avoid a flash of
// protected content before this check resolves).

import { auth } from './firebase-init.js';
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";

onAuthStateChanged(auth, function (user) {
  if (!user) {
    location.replace('login.html');
    return;
  }
  document.body.style.visibility = '';
});
