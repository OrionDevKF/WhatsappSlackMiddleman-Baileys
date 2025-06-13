import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbPath = path.join(__dirname, 'db.json');

async function readDb() {
    try {
        const dbData = await fs.readFile(dbPath, 'utf8');
        return JSON.parse(dbData);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[DB] db.json no encontrado, se creará uno vacío si es necesario guardar mapeos.');
            return { groupMappings: {}, slackChannelMappings: {} }; // Estructura base
        }
        console.error('[DB] Error leyendo db.json:', error);
        throw error;
    }
}

async function writeDb(data) {
    try {
        await fs.writeFile(dbPath, JSON.stringify(data, null, 2), 'utf8');
    } catch (error) {
        console.error('[DB] Error escribiendo en db.json:', error);
        throw error;
    }
}

export async function getWhatsAppJidForSlackChannel(slackChannelId) {
    console.log(`[DB DEBUG] getWhatsAppJidForSlackChannel: Buscando mapeo para Slack Channel ID: '${slackChannelId}'`);
    const db = await readDb();
    if (db && db.groupMappings) {
        console.log('[DB DEBUG] Contenido de db.groupMappings:', JSON.stringify(db.groupMappings, null, 2));
    } else {
        console.log('[DB DEBUG] db.groupMappings no encontrado o db es null/undefined.');
    }
    // Los mapeos bidireccionales están en groupMappings
    // groupMappings tiene la forma { "ID_Origen_1": "ID_Destino_1", "ID_Origen_2": "ID_Destino_2", ... }
    // Si slackChannelId es una clave en groupMappings, su valor es el whatsappJid correspondiente.
    if (db.groupMappings && db.groupMappings[slackChannelId]) {
        const foundJid = db.groupMappings[slackChannelId];
        console.log(`[DB DEBUG] Mapeo encontrado para '${slackChannelId}': '${foundJid}'`);
        return foundJid;
    }
    console.log(`[DB DEBUG] No se encontró mapeo directo para '${slackChannelId}' en db.groupMappings.`);
    return null;
}

export async function getSlackChannelForWhatsAppJid(whatsappJid) {
    const db = await readDb();
    if (db.groupMappings && db.groupMappings[whatsappJid]) {
        return db.groupMappings[whatsappJid];
    }
    return null;
}

// Función para añadir/actualizar un mapeo
export async function mapSlackToWhatsApp(slackChannelId, whatsappJid) {
    const db = await readDb();
    if (!db.groupMappings) {
        db.groupMappings = {};
    }
    // Guardar ambos sentidos en groupMappings
    db.groupMappings[slackChannelId] = whatsappJid; // Slack -> WhatsApp
    db.groupMappings[whatsappJid] = slackChannelId; // WhatsApp -> Slack
    await writeDb(db);
    console.log(`[DB] Mapeo actualizado: Slack ${slackChannelId} <-> WhatsApp ${whatsappJid}`);
}

// Inicializar db.json si no existe con una estructura vacía
async function initializeDbFile() {
    try {
        await fs.access(dbPath);
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('[DB] db.json no existe, creando archivo vacío con estructura base.');
            await writeDb({ groupMappings: {}, slackChannelMappings: {} });
        }
    }
}

initializeDbFile();
