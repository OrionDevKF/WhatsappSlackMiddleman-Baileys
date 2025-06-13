// database-handler.js
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';

class Database {
    constructor() {
        const adapter = new JSONFile('db.json');
        this.db = new Low(adapter, { 
            groupMappings: {}, 
            recentWhatsappChats: [],
            contacts: {} 
        });
    }

    async read() {
        await this.db.read();
    }

    getMapping(whatsappId) {
        // Devuelve el objeto de mapeo completo o undefined si no existe
        return this.db.data.groupMappings[whatsappId];
    }

    async addMapping(whatsappId, mappingDetails) {
        // mappingDetails debe ser un objeto como { slackChannelId, slackChannelName, whatsappChatName }
        this.db.data.groupMappings[whatsappId] = mappingDetails;
        await this.db.write();
    }

    async removeMapping(whatsappId) {
        delete this.db.data.groupMappings[whatsappId];
        await this.db.write();
    }
    
    getAllMappings() {
        return this.db.data.groupMappings;
    }

    // NUEVA FUNCIÓN PARA OBTENER NOMBRE DE CONTACTO PERSONALIZADO
    getCustomContactName(whatsappId) {
        if (this.db.data.contacts && this.db.data.contacts[whatsappId]) {
            return this.db.data.contacts[whatsappId];
        }
        return undefined; 
    }
}

const db = new Database();
// Inicializa la base de datos leyendo el archivo al arrancar.
db.read();

export default db;
export const read = db.read.bind(db);
export const getMapping = db.getMapping.bind(db);
export const addMapping = db.addMapping.bind(db);
export const removeMapping = db.removeMapping.bind(db);
export const getAllMappings = db.getAllMappings.bind(db);
export const getCustomContactName = db.getCustomContactName.bind(db);

// Nuevas funciones para la gestión de contactos
Database.prototype.addContact = async function(phoneNumber, name, role) {
    const whatsappId = `${phoneNumber}@s.whatsapp.net`;
    if (!this.db.data.contacts) {
        this.db.data.contacts = {};
    }
    this.db.data.contacts[whatsappId] = `${name} - ${role}`.trim();
    await this.db.write();
    return { whatsappId, name, role };
};

Database.prototype.editContact = async function(phoneNumber, newName, newRole) {
    const whatsappId = `${phoneNumber}@s.whatsapp.net`;
    if (this.db.data.contacts && this.db.data.contacts[whatsappId]) {
        this.db.data.contacts[whatsappId] = `${newName} - ${newRole}`.trim();
        await this.db.write();
        return { whatsappId, name: newName, role: newRole };
    }
    return null; // O manejar el error si el contacto no existe
};

Database.prototype.getAllContacts = function() {
    return this.db.data.contacts || {};
};

export const addContact = db.addContact.bind(db);
export const editContact = db.editContact.bind(db);
export const getAllContacts = db.getAllContacts.bind(db);


// Nuevas funciones para recentWhatsappChats
Database.prototype.getRecentChats = function() {
    return this.db.data.recentWhatsappChats || [];
};

Database.prototype.updateRecentChats = async function(chatsArray) {
    this.db.data.recentWhatsappChats = chatsArray;
    await this.db.write();
};

export const getRecentChats = db.getRecentChats.bind(db);
export const updateRecentChats = db.updateRecentChats.bind(db);
