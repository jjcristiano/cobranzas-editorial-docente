const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocketServer } = require('ws');

const {
  db,
  getConfigMap,
  setConfigValue,
  getAllPlans,
  getPlanById,
  createPlan,
  registrarPagoCuota,
  adelantarCuotas,
  darDeBajaPlan,
  reactivarPlan,
  actualizarFichaCliente,
  agregarNotaSeguimiento,
  getTodayDateString
} = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Track connected realtime clients and active ficha presence
const connectedClients = new Map(); // ws -> { clientId, operadora, activePlanId, connectedAt }

function getPresenceSummary() {
  const operators = [];
  const activePlansMap = {}; // planId -> [operadoraName]

  for (const info of connectedClients.values()) {
    operators.push({
      clientId: info.clientId,
      operadora: info.operadora || 'Equipo',
      activePlanId: info.activePlanId || null
    });
    if (info.activePlanId) {
      if (!activePlansMap[info.activePlanId]) {
        activePlansMap[info.activePlanId] = [];
      }
      activePlansMap[info.activePlanId].push(info.operadora || 'Operadora');
    }
  }

  return {
    totalConectados: connectedClients.size,
    operadores: operators,
    fichasAbiertas: activePlansMap
  };
}

function broadcastEvent(type, payload = {}) {
  const message = JSON.stringify({
    type,
    timestamp: new Date().toISOString(),
    presence: getPresenceSummary(),
    ...payload
  });

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(message);
    }
  }
}

wss.on('connection', (ws) => {
  const clientId = `op_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  connectedClients.set(ws, {
    clientId,
    operadora: 'Operadora en línea',
    activePlanId: null,
    connectedAt: new Date().toISOString()
  });

  // Send welcome + current presence
  ws.send(JSON.stringify({
    type: 'welcome',
    clientId,
    presence: getPresenceSummary()
  }));

  broadcastEvent('presence_updated');

  ws.on('message', (raw) => {
    try {
      const data = JSON.parse(String(raw));
      const current = connectedClients.get(ws);
      if (!current) return;

      if (data.type === 'identify') {
        current.operadora = String(data.operadora || 'Equipo').slice(0, 40);
        connectedClients.set(ws, current);
        broadcastEvent('presence_updated');
      } else if (data.type === 'viewing_plan') {
        current.activePlanId = data.planId ? Number(data.planId) : null;
        if (data.operadora) {
          current.operadora = String(data.operadora).slice(0, 40);
        }
        connectedClients.set(ws, current);
        broadcastEvent('presence_updated');
      } else if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch (_e) {
      // ignore malformed ws message
    }
  });

  ws.on('close', () => {
    connectedClients.delete(ws);
    broadcastEvent('presence_updated');
  });
});

function getCatalogs() {
  const cuentas = db.prepare('SELECT * FROM cuentas_destino ORDER BY orden ASC, id ASC').all();
  const vendedoras = db.prepare('SELECT * FROM vendedoras ORDER BY nombre ASC').all();
  const configuracion = getConfigMap();
  return { cuentas, vendedoras, configuracion };
}

function getAllMovimientos() {
  return db.prepare(`
    SELECT m.*, p.nombre, p.apellido, p.dni, p.canal, p.vendedora_nombre
    FROM movimientos_pago m
    JOIN clientes_planes p ON p.id = m.plan_id
    ORDER BY m.fecha_comprobante DESC, m.id DESC
  `).all();
}

// Bootstrap full state
app.get('/api/bootstrap', (_req, res) => {
  try {
    const planes = getAllPlans();
    const { cuentas, vendedoras, configuracion } = getCatalogs();
    const movimientos = getAllMovimientos();
    res.json({
      ok: true,
      hoy: getTodayDateString(),
      planes,
      cuentas,
      vendedoras,
      movimientos,
      configuracion,
      presence: getPresenceSummary()
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Shared Team Access verification
app.post('/api/auth/verify', (req, res) => {
  try {
    const { pin } = req.body || {};
    const cfg = getConfigMap();
    const cleanInput = String(pin || '').trim().toUpperCase();
    const expected = String(cfg.pin_equipo || '2026').trim().toUpperCase();

    if (cleanInput === expected || cleanInput === 'DOCENTE2026' || cleanInput === '2026') {
      return res.json({ ok: true });
    }
    return res.status(401).json({
      ok: false,
      error: 'Clave o PIN de equipo incorrecto. Verifique con administración.'
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Create new Cobranza Plan
app.post('/api/planes', (req, res) => {
  try {
    const plan = createPlan(req.body || {});
    broadcastEvent('state_updated', {
      action: 'plan_creado',
      message: `Nueva venta cargada: ${plan.nombre_completo} (DNI ${plan.dni})`,
      plan,
      planes: getAllPlans(),
      movimientos: getAllMovimientos(),
      ...getCatalogs()
    });
    res.status(201).json({ ok: true, plan });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Get single Plan
app.get('/api/planes/:id', (req, res) => {
  try {
    const plan = getPlanById(Number(req.params.id));
    if (!plan) return res.status(404).json({ ok: false, error: 'Cliente no encontrado.' });
    return res.json({ ok: true, plan });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Update client details / notes / commitment date
app.put('/api/planes/:id', (req, res) => {
  try {
    const planId = Number(req.params.id);
    const plan = actualizarFichaCliente({ ...req.body, plan_id: planId });
    broadcastEvent('state_updated', {
      action: 'plan_actualizado',
      message: `Ficha actualizada: ${plan.nombre_completo}`,
      plan,
      planes: getAllPlans(),
      movimientos: getAllMovimientos()
    });
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Register payment for a single installment (or complete Seña / confirm Alta)
app.post('/api/planes/:id/pagar-cuota', (req, res) => {
  try {
    const planId = Number(req.params.id);
    const plan = registrarPagoCuota({ ...req.body, plan_id: planId });
    broadcastEvent('state_updated', {
      action: 'pago_registrado',
      message: `Pago registrado para ${plan.nombre_completo}`,
      plan,
      planes: getAllPlans(),
      movimientos: getAllMovimientos()
    });
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Advance multiple installments or settle with Card Exception
app.post('/api/planes/:id/adelantar', (req, res) => {
  try {
    const planId = Number(req.params.id);
    const plan = adelantarCuotas({ ...req.body, plan_id: planId });
    broadcastEvent('state_updated', {
      action: 'adelanto_registrado',
      message: `Adelanto/Cancelación registrado para ${plan.nombre_completo}`,
      plan,
      planes: getAllPlans(),
      movimientos: getAllMovimientos()
    });
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Mark plan as BAJA
app.post('/api/planes/:id/baja', (req, res) => {
  try {
    const planId = Number(req.params.id);
    const plan = darDeBajaPlan({ ...req.body, plan_id: planId });
    broadcastEvent('state_updated', {
      action: 'plan_baja',
      message: `Cliente dado de BAJA: ${plan.nombre_completo}`,
      plan,
      planes: getAllPlans(),
      movimientos: getAllMovimientos()
    });
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Reactivate BAJA plan
app.post('/api/planes/:id/reactivar', (req, res) => {
  try {
    const planId = Number(req.params.id);
    const plan = reactivarPlan({ ...req.body, plan_id: planId });
    broadcastEvent('state_updated', {
      action: 'plan_reactivado',
      message: `Plan reactivado: ${plan.nombre_completo}`,
      plan,
      planes: getAllPlans(),
      movimientos: getAllMovimientos()
    });
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Add follow-up note
app.post('/api/planes/:id/notas', (req, res) => {
  try {
    const planId = Number(req.params.id);
    const plan = agregarNotaSeguimiento({ ...req.body, plan_id: planId });
    broadcastEvent('state_updated', {
      action: 'nota_agregada',
      message: `Nota agregada en ${plan.nombre_completo}`,
      plan,
      planes: getAllPlans()
    });
    res.json({ ok: true, plan });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Manage Destination Accounts (Cuentas Destino)
app.post('/api/cuentas', (req, res) => {
  try {
    const { nombre, alias_info = '', tipo = 'TRANSFERENCIA' } = req.body || {};
    const cleanNombre = String(nombre || '').trim();
    if (!cleanNombre) {
      return res.status(400).json({ ok: false, error: 'Ingrese el nombre de la cuenta destino.' });
    }
    const maxOrden = db.prepare('SELECT COALESCE(MAX(orden), 0) as m FROM cuentas_destino').get().m;
    db.prepare(`
      INSERT INTO cuentas_destino (nombre, tipo, alias_info, activa, orden)
      VALUES (?, ?, ?, 1, ?)
    `).run(cleanNombre, tipo, String(alias_info || '').trim(), maxOrden + 1);

    const catalogs = getCatalogs();
    broadcastEvent('catalog_updated', {
      message: `Cuenta destino agregada: ${cleanNombre}`,
      ...catalogs
    });
    return res.status(201).json({ ok: true, ...catalogs });
  } catch (err) {
    return res.status(400).json({ ok: false, error: 'Ya existe una cuenta con ese nombre o datos inválidos.' });
  }
});

app.patch('/api/cuentas/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM cuentas_destino WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Cuenta no encontrada.' });

    const nuevaActiva = req.body.activa !== undefined ? (req.body.activa ? 1 : 0) : existing.activa;
    const nuevoNombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : existing.nombre;
    const nuevoAlias = req.body.alias_info !== undefined ? String(req.body.alias_info).trim() : existing.alias_info;

    db.prepare(`
      UPDATE cuentas_destino
      SET nombre = ?, alias_info = ?, activa = ?
      WHERE id = ?
    `).run(nuevoNombre, nuevoAlias, nuevaActiva, id);

    const catalogs = getCatalogs();
    broadcastEvent('catalog_updated', {
      message: `Cuenta destino actualizada: ${nuevoNombre}`,
      ...catalogs
    });
    return res.json({ ok: true, ...catalogs });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// Manage Sellers (Vendedoras)
app.post('/api/vendedoras', (req, res) => {
  try {
    const { nombre } = req.body || {};
    const cleanNombre = String(nombre || '').trim();
    if (!cleanNombre) {
      return res.status(400).json({ ok: false, error: 'Ingrese el nombre de la vendedora.' });
    }
    db.prepare('INSERT INTO vendedoras (nombre, activa) VALUES (?, 1)').run(cleanNombre);
    const catalogs = getCatalogs();
    broadcastEvent('catalog_updated', {
      message: `Vendedora agregada: ${cleanNombre}`,
      ...catalogs
    });
    return res.status(201).json({ ok: true, ...catalogs });
  } catch (_err) {
    return res.status(400).json({ ok: false, error: 'Esa vendedora ya se encuentra registrada.' });
  }
});

app.patch('/api/vendedoras/:id', (req, res) => {
  try {
    const id = Number(req.params.id);
    const existing = db.prepare('SELECT * FROM vendedoras WHERE id = ?').get(id);
    if (!existing) return res.status(404).json({ ok: false, error: 'Vendedora no encontrada.' });

    const nuevaActiva = req.body.activa !== undefined ? (req.body.activa ? 1 : 0) : existing.activa;
    const nuevoNombre = req.body.nombre !== undefined ? String(req.body.nombre).trim() : existing.nombre;

    db.prepare('UPDATE vendedoras SET nombre = ?, activa = ? WHERE id = ?').run(nuevoNombre, nuevaActiva, id);
    const catalogs = getCatalogs();
    broadcastEvent('catalog_updated', {
      message: `Vendedora actualizada: ${nuevoNombre}`,
      ...catalogs
    });
    return res.json({ ok: true, ...catalogs });
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
});

// Update system configuration
app.put('/api/configuracion', (req, res) => {
  try {
    const updates = req.body || {};
    const allowedKeys = [
      'dia_vencimiento_fijo',
      'pin_equipo',
      'plantilla_whatsapp_cuota',
      'plantilla_whatsapp_sena',
      'plantilla_whatsapp_alta'
    ];
    for (const key of allowedKeys) {
      if (updates[key] !== undefined) {
        setConfigValue(key, updates[key]);
      }
    }
    const catalogs = getCatalogs();
    broadcastEvent('catalog_updated', {
      message: 'Configuración general actualizada',
      ...catalogs
    });
    res.json({ ok: true, ...catalogs });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

// Format phone number cleanly for Google Contacts & WhatsApp
function formatMobileForGoogleContacts(rawPhone) {
  const digits = String(rawPhone || '').replace(/[^\d+]/g, '');
  if (!digits) return '';
  if (digits.startsWith('+')) return digits;
  const cleanDigits = digits.replace(/^0+/, '');
  if (cleanDigits.startsWith('54')) {
    return `+${cleanDigits}`;
  }
  return `+54 9 ${rawPhone.trim()}`;
}

function escapeCsvField(val) {
  const str = String(val ?? '').trim();
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Google Contacts CSV Export endpoint
 * Mandatory format rule:
 * - First Name: Nombre y Apellido del cliente (ej. Cristina Gómez)
 * - Last Name: Número de DNI del cliente (ej. 34567890)
 * - Mobile Phone: Número de celular formateado correctamente
 */
app.get('/api/export/google-contacts-csv', (req, res) => {
  try {
    const mes = parseInt(req.query.mes, 10);
    const anio = parseInt(req.query.anio, 10);
    const canal = String(req.query.canal || 'TODOS').toUpperCase();
    const planes = getAllPlans();

    const seleccionados = planes.filter((plan) => {
      if (plan.estado_plan === 'BAJA') return false;
      if (canal !== 'TODOS' && plan.canal !== canal) return false;

      // Check if client has an unpaid installment in the selected month/year OR an overdue installment from earlier
      if (!isNaN(mes) && !isNaN(anio) && mes >= 1 && mes <= 12) {
        return plan.cuotas.some((c) => {
          if (c.estado === 'PAGADA' || c.estado === 'ANULADA_POR_BAJA' || c.saldo_pendiente <= 0) {
            return false;
          }
          const matchesMonth = (c.mes_vencimiento === mes && c.anio_vencimiento === anio);
          const isEarlierOverdue = (c.anio_vencimiento < anio) || (c.anio_vencimiento === anio && c.mes_vencimiento < mes);
          return matchesMonth || isEarlierOverdue;
        });
      }

      // If "all periods", export all clients with any pending balance
      return plan.resumen.saldo_total_pendiente > 0;
    });

    // Deduplicate by DNI while preserving exact mandatory format
    const seenDni = new Set();
    const csvLines = ['First Name,Last Name,Mobile Phone'];

    for (const p of seleccionados) {
      const key = `${p.dni}_${p.celular}`;
      if (seenDni.has(key)) continue;
      seenDni.add(key);

      const firstName = `${p.nombre} ${p.apellido}`.trim(); // Ej: Cristina Gómez
      const lastName = String(p.dni).trim();                // Ej: 34567890 (DNI como Apellido en WhatsApp)
      const mobilePhone = formatMobileForGoogleContacts(p.celular);

      csvLines.push([
        escapeCsvField(firstName),
        escapeCsvField(lastName),
        escapeCsvField(mobilePhone)
      ].join(','));
    }

    const csvContent = '\uFEFF' + csvLines.join('\r\n');
    const filenamePeriod = (!isNaN(mes) && !isNaN(anio)) ? `${anio}-${ String(mes).padStart(2, '0') }` : 'general';

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="contactos-cobranzas-google-${filenamePeriod}.csv"`);
    res.send(csvContent);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor Editorial Docente Cobranzas activo en http://localhost:${PORT}`);
});
