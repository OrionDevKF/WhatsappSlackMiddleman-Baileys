/**
 * Configuración de tokens y parámetros para la integración WhatsApp-Slack.
 * Todas las variables sensibles se cargan desde archivo .env
 */

export const slack = {
    token: process.env.SLACK_BOT_TOKEN,
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    appToken: process.env.SLACK_APP_TOKEN,
    botId: process.env.SLACK_BOT_ID, 
    adminTeamUserGroupId: process.env.SLACK_ADMIN_TEAM_USER_GROUP_ID
};

// Canal principal de Slack para notificaciones y mensajes no mapeados
export const mainSlackChannel = process.env.SLACK_MAIN_CHANNEL;

// Número de teléfono para el código de emparejamiento de WhatsApp
export const whatsappPhoneNumber = process.env.WHATSAPP_PHONE_NUMBER;
