// Firebase app init — shared by every page that needs auth or Firestore.
// Loaded as an ES module straight from the gstatic CDN, no npm/bundler.
// This config is the public web SDK config, not a secret — safe to commit.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDOgFuqKuWhoxYo0D8AjaswcGoRjCSoRHI",
  authDomain: "madrid-trip-76a65.firebaseapp.com",
  projectId: "madrid-trip-76a65",
  storageBucket: "madrid-trip-76a65.firebasestorage.app",
  messagingSenderId: "81198088283",
  appId: "1:81198088283:web:db0f3a0278f5256db83f7e"
};

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
