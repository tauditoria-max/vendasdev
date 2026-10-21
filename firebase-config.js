// Cole aqui as configurações do seu Console Firebase
const firebaseConfig = {
  apiKey: "AIzaSyBMhsV9crM4_opjA0s-j3aJoshGeau4Y8Q",
  authDomain: "vendas-46875.firebaseapp.com",
  projectId: "vendas-46875",
  storageBucket: "vendas-46875.firebasestorage.app",
  messagingSenderId: "508982358513",
  appId: "1:508982358513:web:ff968ed6c29b4946519450"
};

// Inicializa o Firebase
firebase.initializeApp(firebaseConfig);

// Referências globais
const db = firebase.firestore();
const auth = firebase.auth();