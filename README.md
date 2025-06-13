# WhatsApp-Slack Middleman

Bot intermediario que permite la comunicación bidireccional entre grupos de WhatsApp y canales de Slack. Esta herramienta facilita la interconexión entre ambas plataformas de mensajería, permitiendo compartir mensajes de texto y archivos multimedia.

## Características Principales

- **Comunicación bidireccional**: Envío y recepción de mensajes entre WhatsApp y Slack
- **Soporte para multimedia**: Imágenes, videos, documentos y otros archivos multimedia
- **Mapeo configurable**: Configura qué grupos de WhatsApp se conectan con qué canales de Slack
- **Comandos de administración**: Gestiona conexiones y configuraciones desde Slack
- **Sistema de contactos**: Guarda y administra contactos con nombres y roles
- **Notificaciones de estado**: Recibe alertas sobre el estado de la conexión

## Requisitos Previos

- Node.js (versión 16.x o superior)
- npm o yarn
- Una cuenta de WhatsApp activa (no WhatsApp Business)
- Un espacio de trabajo de Slack con permisos para crear aplicaciones
- Tokens de API de Slack (Bot Token, Signing Secret y App Token)

## Instalación

1. **Clonar el repositorio:**
   ```bash
   git clone https://github.com/username/whatsapp-slack-middleman.git
   cd whatsapp-slack-middleman
   ```

2. **Instalar dependencias:**
   ```bash
   npm install
   ```

3. **Configuración de variables de entorno:**
   - Copia el archivo `.env.example` a `.env` en la raíz del proyecto:
     ```bash
     cp .env.example .env
     ```
   - Edita el archivo `.env` con tus propios valores (ver `.env.example` para la lista completa).

4. **Permisos del Bot de Slack (Scopes):**
   Al crear o configurar tu aplicación de Slack en [api.slack.com/apps](https://api.slack.com/apps), asegúrate de que tu Bot Token tenga los siguientes scopes (permisos):

   - `app_mentions:read`: Para leer menciones al bot (si se usa Socket Mode para menciones).
   - `channels:history`: Para leer mensajes en canales donde el bot es miembro (necesario para algunos flujos).
   - `channels:join`: Para permitir que el bot se una a canales públicos.
   - `channels:read`: Para leer información básica sobre canales públicos.
   - `chat:write`: Para enviar mensajes como el bot.
   - `commands`: Para registrar y responder a comandos slash.
   - `files:read`: Para leer archivos compartidos en Slack (si el bot necesita procesarlos).
   - `files:write`: Para subir archivos a Slack (fundamental para enviar multimedia desde WhatsApp).
   - `groups:history`: Para leer mensajes en canales privados donde el bot es miembro.
   - `groups:read`: Para leer información básica sobre canales privados.
   - `groups:write`: Para enviar mensajes a canales privados (si es necesario).
   - `im:history`: Para leer mensajes en DMs con el bot.
   - `im:read`: Para leer información sobre DMs.
   - `im:write`: Para enviar DMs.
   - `mpim:history`: Para leer mensajes en DMs grupales donde el bot es miembro.
   - `mpim:read`: Para leer información sobre DMs grupales.
   - `mpim:write`: Para enviar mensajes a DMs grupales.
   - `users:read`: Para obtener información básica de usuarios (como nombres para mostrar).

   *Nota*: Es posible que no necesites todos estos permisos dependiendo de la configuración exacta y las funcionalidades que utilices. Comienza con los esenciales (`chat:write`, `files:write`, `commands`) y añade otros según sea necesario.

## Uso

Para iniciar el bot:

```bash
npm start
```

La primera vez que se ejecute, necesitarás escanear un código QR con tu aplicación de WhatsApp para autenticar la sesión.

## Comandos de Slack

El bot responde a los siguientes comandos slash en Slack:

- `/status` - Muestra el estado de conexión del bot y el número de conversaciones activas.
- `/map [ID_GRUPO_WHATSAPP] [#canal-slack]` - Mapea un grupo de WhatsApp a un canal de Slack. 
  - *Nota*: El `ID_GRUPO_WHATSAPP` usualmente tiene el formato `xxxxxxxxxx@g.us` o `xxxxxxxxxx-yyyyyyyy@g.us`.
- `/unmap [ID_GRUPO_WHATSAPP]` - Elimina un mapeo existente.
- `/listmaps` - Muestra todos los mapeos configurados.
- `/contacts new [numero_telefono] [nombre_completo] - [rol]` - Añade un nuevo contacto.
- `/contacts view` - Lista todos los contactos guardados.
- `/contacts edit [numero_telefono] [nuevo_nombre] - [nuevo_rol]` - Edita un contacto existente.

## Estructura del Proyecto

- `bot.js` - Punto de entrada principal y controlador central
- `config.js` - Configuración de tokens y parámetros
- `database-handler.js` - Gestión de la base de datos JSON
- `whatsapp-handler.js` - Cliente y manejo de eventos de WhatsApp
- `slack-handler.js` - Cliente y manejo de eventos de Slack
- `media-handler.js` - Procesamiento de archivos multimedia
- `server.js` - Servidor Express para webhooks (si aplica)
- `db.json` - Base de datos JSON para almacenar mapeos y contactos
- `baileys_auth_info/` - Directorio que almacena la sesión de WhatsApp

## Notas Técnicas

- Utiliza [Baileys/WhiskeySockets](https://github.com/WhiskeySockets/Baileys) para la conexión con WhatsApp
- Implementa [Slack Bolt](https://slack.dev/bolt-js/tutorial/getting-started) para la integración con Slack
- Almacena datos en archivos JSON utilizando [lowdb](https://github.com/typicode/lowdb)

## Solución de Problemas

- Si la conexión con WhatsApp se pierde, el bot intentará reconectarse automáticamente
- Para forzar una nueva autenticación de WhatsApp, elimina el directorio `baileys_auth_info`
- Verifica los registros en `wa-logs.txt` para diagnosticar problemas

## Consideraciones de Despliegue

Para mantener el bot ejecutándose de forma continua en un servidor, se recomienda utilizar un gestor de procesos como [PM2](https://pm2.keymetrics.io/).

```bash
# Instalar PM2 globalmente (si no lo tienes)
npm install pm2 -g

# Iniciar el bot con PM2
pm2 start bot.js --name whatsapp-slack-middleman

# Guardar la configuración de PM2 para que se reinicie con el servidor
pm2 save
```

## Limitaciones Conocidas

- No compatible con Whatsapp Business API

## Cómo Obtener Ayuda

Si encuentras algún problema o tienes alguna pregunta, por favor, abre un [Issue en GitHub](https://github.com/OrionDevKF/whatsapp-slack-middleman-Baileys/issues).

## Contribuciones

Las contribuciones son bienvenidas. Por favor, abre un issue para discutir las características antes de enviar un pull request.

## Licencia

Este proyecto está licenciado bajo la licencia ISC.
