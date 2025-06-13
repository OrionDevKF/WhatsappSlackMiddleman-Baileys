/**
 * Bot intermediario WhatsApp-Slack
 * Punto de entrada principal que coordina la comunicación bidireccional
 * entre WhatsApp y Slack
 */

import { DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import WhatsAppClient from './whatsapp-handler.js';
import { initializeSlack, onSlackCommand as registerSlackCommandHandler, slackApp } from './slack-handler.js';
import { slack, mainSlackChannel } from './config.js';
import * as db from './database-handler.js';
import { addContact, getAllContacts, editContact } from './database-handler.js';
import fetch from 'node-fetch';
import MediaHandler from './media-handler.js';
import fs from 'fs';
import path from 'path';

const waClient = new WhatsAppClient();

// Manejar actualizaciones de conexión de WhatsApp para notificar a Slack
waClient.onConnectionUpdate(async ({ connection, reason }) => {
    let message = '';
    if (connection === 'close') {
        message = '🔴 Conexión con WhatsApp cerrada. Razón: ' + reason + '. El bot intentará reconectarse automáticamente.';
    } else if (connection === 'open') {
        message = '🟢 Conexión con WhatsApp establecida correctamente.';
    }

    if (message && mainSlackChannel) {
        try {
            await slackApp.client.chat.postMessage({
                token: slack.token,
                channel: mainSlackChannel,
                text: message
            });
        } catch (error) {
            console.error('Error al enviar notificación de estado a Slack:', error);
        }
    }
});

// 1. Manejar mensajes de WhatsApp y enviarlos a Slack
waClient.onMessage(async (msg) => {
    const groupJid = msg.key.remoteJid;
    
    await db.read();
    const slackChannelId = db.getMapping(groupJid);

    if (!slackChannelId) {
        console.log(`Mensaje del grupo ${groupJid} no tiene canal de Slack mapeado. Usa /map para añadirlo.`);
        return;
    }

    const senderName = msg.pushName || 'Desconocido';
    let text = '';

    // Detectar el tipo de mensaje para texto
    if (msg.message?.conversation) {
        text = msg.message.conversation;
    } else if (msg.message?.extendedTextMessage) {
        text = msg.message.extendedTextMessage.text;
    }

    try {
        // Procesar posibles medios adjuntos
        const mediaData = await MediaHandler.processWhatsAppMedia(msg, async (mediaObj) => {
            return await waClient.downloadMedia(mediaObj);
        });

        const isGroup = groupJid.endsWith('@g.us');
        const messageText = isGroup
            ? `*[${senderName}]*: ${mediaData?.caption || text}`
            : `*[DM] ${senderName}*: ${mediaData?.caption || text}`;

        if (mediaData) {
            // Tenemos un archivo multimedia
            console.log(`Archivo multimedia detectado de tipo: ${mediaData.type}`);
            
            // Enviar el archivo a Slack con su caption
            await slackApp.client.files.uploadV2({
                channel_id: slackChannelId,
                initial_comment: messageText,
                file: mediaData.buffer,
                filename: mediaData.name,
                title: mediaData.name,
                filetype: mediaData.mimetype,
                token: slack.token,
            });
        } else if (text) {
            // Solo texto, sin archivos
            await slackApp.client.chat.postMessage({
                channel: slackChannelId,
                text: messageText,
                token: slack.token,
            });
        }
    } catch (error) {
        console.error('Error al enviar mensaje/archivo a Slack:', error);
        
        // Intento de recuperación: mandar al menos el texto si hay un error con el archivo
        if (text) {
            try {
                const fallbackText = `*[${senderName}]*: ${text}\n\n_[Error al procesar un archivo adjunto]_`;
                await slackApp.client.chat.postMessage({
                    channel: slackChannelId,
                    text: fallbackText,
                    token: slack.token,
                });
            } catch (fallbackError) {
                console.error('Error incluso al enviar mensaje de texto fallback:', fallbackError);
            }
        }
    }
});

// 2. El manejo de mensajes de Slack a WhatsApp se realiza directamente en slack-handler.js
// No necesitamos código adicional aquí ya que slack-handler.js se encarga de todo

// 3. Manejar comandos de Slack
async function processSlackCommand(command, text) {
    const args = text ? text.trim().split(' ') : [];

    if (command === '/status') {
        const connectionState = waClient.isConnected ? '🟢 Conectado' : '🔴 Desconectado';
        
        // Obtener todos los mapeos para mostrar conversaciones activas
        await db.read();
        const allMappings = db.getAllMappings();
        const activeConversations = Object.keys(allMappings).length;
        
        return `*Estado del Bot Intermediario*:\n- *Conexión a WhatsApp*: ${connectionState}\n- *Conversaciones activas (grupos mapeados)*: ${activeConversations}`;
    }

    if (command === '/map') {
        const [waId, slackChannel] = args;
        const slackId = slackChannel?.match(/<#(\w+)\|/)?.[1] || slackChannel;

        if (!waId || !slackId) {
            return 'Uso incorrecto. Formato: `/map ID_GRUPO_WHATSAPP @canal-slack`\n*Ejemplo*: `/map 12345@g.us #general`';
        }
        await db.addMapping(waId, slackId);
        return `✅ Mapeo añadido: Grupo de WhatsApp \`${waId}\` ahora enviará a <#${slackId}>.`;
    }

    if (command === '/unmap') {
        const waId = args[0];
        if (!waId) {
            return 'Uso incorrecto. Formato: `/unmap ID_GRUPO_WHATSAPP`';
        }
        await db.removeMapping(waId);
        return `🗑️ Mapeo para el grupo \`${waId}\` eliminado.`;
    }
    
    if (command === '/listmaps') {
        await db.read();
        const allMappings = db.getAllMappings();
        const mappingList = Object.entries(allMappings);
        
        if (mappingList.length === 0) {
            return 'No hay mapeos configurados. Usa `/map` para añadir uno.';
        }
        
        let response = '*Lista de Mapeos Activos:*\n';
        mappingList.forEach(([waId, slackId]) => {
            response += `- *WA:* \`${waId}\` -> *Slack:* <#${slackId}>\n`;
        });
        return response;
    }

    if (command === '/contacts') {
        const subCommand = args[0]?.toLowerCase();
        await db.read(); // Asegurarse que la DB está actualizada

        if (subCommand === 'new') {
            // /contacts new 573301233042 Pepito Perez - Admin
            const phoneNumber = args[1];
            const nameAndRoleString = args.slice(2).join(' ');
            const parts = nameAndRoleString.split(' - ');
            const name = parts[0]?.trim();
            const role = parts[1]?.trim();

            if (!phoneNumber || !name || !role) {
                return 'Uso incorrecto. Formato: `/contacts new <numero_telefono> <nombre_completo> - <rol>`\nEjemplo: `/contacts new 573001234567 Juan Perez - Cliente`';
            }
            if (!/^\d+$/.test(phoneNumber)) {
                return 'Error: El número de teléfono solo debe contener dígitos.';
            }

            try {
                const newContact = await addContact(phoneNumber, name, role);
                return `✅ Contacto añadido: ${newContact.name} (${newContact.role}) con el número ${newContact.whatsappId}.`;
            } catch (error) {
                console.error('Error al añadir contacto:', error);
                return '❌ Error al añadir el contacto. Revisa los logs.';
            }
        } else if (subCommand === 'view') {
            const contacts = getAllContacts();
            const contactList = Object.entries(contacts);

            if (contactList.length === 0) {
                return 'No hay contactos guardados. Usa `/contacts new` para añadir uno.';
            }

            let response = '*Lista de Contactos Guardados:*\n';
            contactList.forEach(([whatsappId, nameAndRole]) => {
                response += `- *${whatsappId}*: ${nameAndRole}\n`;
            });
            return response;
        } else if (subCommand === 'edit') {
            // /contacts edit 573301233042 Pepito Perez - Actualizado
            const phoneNumber = args[1];
            const nameAndRoleString = args.slice(2).join(' ');
            const parts = nameAndRoleString.split(' - ');
            const newName = parts[0]?.trim();
            const newRole = parts[1]?.trim();

            if (!phoneNumber || !newName || !newRole) {
                return 'Uso incorrecto. Formato: `/contacts edit <numero_telefono> <nuevo_nombre_completo> - <nuevo_rol>`\nEjemplo: `/contacts edit 573001234567 Juan Perez - Cliente VIP`';
            }
            if (!/^\d+$/.test(phoneNumber)) {
                return 'Error: El número de teléfono solo debe contener dígitos.';
            }

            try {
                const updatedContact = await editContact(phoneNumber, newName, newRole);
                if (updatedContact) {
                    return `✅ Contacto actualizado: ${updatedContact.name} (${updatedContact.role}) para el número ${updatedContact.whatsappId}.`;
                } else {
                    return `⚠️ No se encontró un contacto con el número ${phoneNumber}@s.whatsapp.net para editar.`;
                }
            } catch (error) {
                console.error('Error al editar contacto:', error);
                return '❌ Error al editar el contacto. Revisa los logs.';
            }
        } else {
            return 'Subcomando de `/contacts` no reconocido. Usa `new`, `view` o `edit`.\nEjemplos:\n`/contacts new 573001234567 Juan Perez - Cliente`\n`/contacts view`\n`/contacts edit 573001234567 Juan Perez - Cliente VIP`';
        }
    }

    return `Comando "${command}" no reconocido.`;
}

// 4. Inicializar los clientes
(async () => {
    try {
        await db.read(); // Cargar la base de datos primero
        console.log('Iniciando conexión con WhatsApp...');
        await waClient.connect(); // Conectar a WhatsApp y esperar la entrada del usuario
        console.log('Conexión con WhatsApp iniciada, ahora iniciando Slack...');

        // Registrar el manejador de comandos de Slack ANTES de inicializar completamente los listeners de Slack
        console.log('[INFO BOT] Registrando el manejador de comandos de Slack...');
        registerSlackCommandHandler(processSlackCommand);
        
        // Iniciar Slack y pasar el cliente de WhatsApp
        // initializeSlack configurará los listeners de Bolt, incluyendo el que usa commandCallbackInstance
        console.log('Iniciando servicios de Slack y listeners de Bolt...');
        initializeSlack(waClient);
        
        console.log('Bot intermediario iniciado. Esperando eventos...');
    } catch (error) {
        console.error('Error fatal durante la inicialización:', error);
    }
})();
