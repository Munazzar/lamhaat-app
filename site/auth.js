// Google sign-in through Firebase Auth. The browser only ever holds a short-lived Firebase ID
// token; the Worker checks it and the allowlist before anything private is returned.
const SDK = 'https://www.gstatic.com/firebasejs/13.0.0';
let auth, fb;

export async function init(firebaseConfig) {
  const [{ initializeApp }, authMod] = await Promise.all([import(`${SDK}/firebase-app.js`), import(`${SDK}/firebase-auth.js`)]);
  fb = authMod;
  auth = fb.getAuth(initializeApp(firebaseConfig));
  await auth.authStateReady();
  return auth.currentUser;
}

export const user = () => auth?.currentUser || null;
export const idToken = () => auth.currentUser.getIdToken();
export async function signIn() {
  const provider = new fb.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  return (await fb.signInWithPopup(auth, provider)).user;
}
export const signOut = () => fb.signOut(auth);
