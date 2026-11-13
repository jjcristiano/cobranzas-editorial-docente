# Editorial Docente — Sistema de Cobranzas y Cuentas Corrientes

Sistema web Full-Stack en tiempo real (Node.js + SQLite ACID + WebSockets) diseñado específicamente con accesibilidad de alto contraste para el equipo administrativo y operadoras de cobranzas de **Editorial Docente**.

## Archivos Principales
- `server.js`: Servidor HTTP Express + Servidor WebSocket (`/ws`) para sincronización instantánea entre todas las PCs conectadas + Exportador Google Contacts CSV.
- `db.js`: Motor de base de datos persistente SQLite (`data/editorial_docente.sqlite`) con transacciones atómicas y reglas de negocio.
- `public/index.html`, `public/styles.css`, `public/app.js`: Interfaz de usuario de alto contraste con selector de tamaño de letra (`A`, `A+`, `A++`), pestañas por canal y filtros rápidos de 1 clic.
- `Dockerfile`: Listo para desplegar en **Railway**, **Render**, **Fly.io** o cualquier servidor VPS.

## Ejecución
```bash
npm install
npm start
```
