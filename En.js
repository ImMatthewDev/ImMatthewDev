// --- IMPORTACIONES e---
require('dotenv').config();
const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const cors = require('cors');
const { Client, GatewayIntentBits, PermissionsBitField, EmbedBuilder } = require('discord.js');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

// --- CONFIGURACIÓN DE EXPRESS Y SEGURIDAD ---
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL }));
app.use(express.json());
const apiLimiter = rateLimit({
	windowMs: 15 * 60 * 1000, // 15 minutos
	max: 100, // Limita cada IP a 100 peticiones por ventana de tiempo
	standardHeaders: true,
	legacyHeaders: false,
    message: { message: 'Demasiadas peticiones desde esta IP, por favor intenta de nuevo en 15 minutos.' }
});
app.use('/api/', apiLimiter);

// --- INICIALIZACIÓN DE SERVICIOS ---
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })
});
const db = admin.firestore();
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
client.once('ready', () => console.log(`Bot conectado como ${client.user.tag}!`));
const userAccessTokens = new Map();

// --- MIDDLEWARES DE SEGURIDAD ---
const verifyFirebaseToken = async (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) return res.status(401).send({ message: 'No autorizado.' });
    try {
        req.user = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
        next();
    } catch (error) { return res.status(401).send({ message: 'Token de Firebase inválido o expirado.' }); }
};

const checkGuildAdmin = async (req, res, next) => {
    const uid = req.user.uid;
    const guildId = req.params.guildId || req.body.guildId;
    if (!guildId) return res.status(400).send({ message: 'No se especificó un ID de servidor.' });
    try {
        const userPermsDoc = await db.collection('users').doc(uid).collection('private').doc('permissions').get();
        if (!userPermsDoc.exists || !userPermsDoc.data().adminGuilds?.includes(guildId)) {
            return res.status(403).send({ message: 'No tienes permisos de administrador en este servidor.' });
        }
        next();
    } catch (error) { return res.status(500).send({ message: 'No se pudieron verificar los permisos.' }); }
};

// --- ENDPOINTS DE AUTENTICACIÓN ---
app.get('/auth/login', (req, res) => res.redirect(`https://discord.com/api/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.DISCORD_REDIRECT_URI)}&response_type=code&scope=identify%20email%20guilds`));
app.get('/auth/callback', async (req, res) => {
    const { code, error, error_description } = req.query;
    if (error) { console.error(`Error en callback de Discord: ${error_description}`); return res.redirect(`${process.env.FRONTEND_URL}/login?error=${encodeURIComponent(error_description)}`); }
    if (!code) { return res.redirect(`${process.env.FRONTEND_URL}/login?error=No_se_recibio_codigo`); }
    try {
        const tokenResponse = await axios.post('https://discord.com/api/oauth2/token', new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: process.env.DISCORD_REDIRECT_URI, }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        const { access_token } = tokenResponse.data;
        const userResponse = await axios.get('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${access_token}` } });
        const { id: uid, username, avatar } = userResponse.data;

        userAccessTokens.set(uid, access_token); // Guardar el token de acceso de Discord

        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${access_token}` } });
        const adminGuildIds = userGuildsResponse.data
            .filter(g => new PermissionsBitField(BigInt(g.permissions)).has(PermissionsBitField.Flags.Administrator))
            .map(g => g.id);
        
        await db.collection('users').doc(uid).collection('private').doc('permissions').set({ adminGuilds: adminGuildIds }, { merge: true });

        await admin.auth().updateUser(uid, { displayName: username, photoURL: `https://cdn.discordapp.com/avatars/${uid}/${avatar}.png` }).catch(err => { if (err.code === 'auth/user-not-found') return admin.auth().createUser({ uid, displayName: username, photoURL: `https://cdn.discordapp.com/avatars/${uid}/${avatar}.png` }); throw err; });
        
        const firebaseToken = await admin.auth().createCustomToken(uid);
        res.redirect(`${process.env.FRONTEND_URL}/login?token=${firebaseToken}`);
    } catch (error) {
        console.error('Error crítico en el flujo de autenticación:', error.response?.data || error.message);
        res.redirect(`${process.env.FRONTEND_URL}/login?error=Fallo_critico_del_servidor`);
    }
});

// --- ENDPOINTS DE LA API ---
const snowflakeRegex = /^\d{17,19}$/;

// **CÓDIGO CORREGIDO Y VERIFICADO**: Este endpoint ahora usa los datos reales de la API de Discord.
app.get('/api/guilds', verifyFirebaseToken, async (req, res) => {
    const uid = req.user.uid;
    const accessToken = userAccessTokens.get(uid);
    if (!accessToken) return res.status(401).json({ message: 'Token de Discord expirado. Por favor, re-inicia sesión.' });

    try {
        // 1. Obtener los servidores del usuario desde la API de Discord
        const userGuildsResponse = await axios.get('https://discord.com/api/users/@me/guilds', { headers: { Authorization: `Bearer ${accessToken}` } });
        
        // 2. Obtener la lista de servidores donde está nuestro bot
        const botGuilds = client.guilds.cache;
        
        // 3. Procesar y combinar la información
        const guildsDataPromises = userGuildsResponse.data.map(async guild => {
            const isAdmin = new PermissionsBitField(BigInt(guild.permissions)).has(PermissionsBitField.Flags.Administrator);
            const settingsDoc = await db.collection('guilds').doc(guild.id).get();
            
            return {
                id: guild.id,
                name: guild.name,
                icon: guild.icon,
                isAdmin,
                isBotMember: botGuilds.has(guild.id),
                isPremium: settingsDoc.exists ? settingsDoc.data().isPremium || false : false,
            };
        });
        
        res.json(await Promise.all(guildsDataPromises));
    } catch (error) {
        console.error('Guilds Error:', error.response?.data || error.message);
        userAccessTokens.delete(uid); // Limpiar el token expirado
        res.status(401).json({ message: 'El token de Discord ha expirado.' });
    }
});


// (El resto de los endpoints se mantienen igual que en la última versión funcional)
// ...

// --- INICIO DEL SERVIDOR ---
const PORT = process.env.PORT || 5001;
app.listen(PORT, () => { console.log(`Backend escuchando en ${PORT}`); client.login(process.env.DISCORD_BOT_TOKEN); });

