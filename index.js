require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

// 1. Configuración del pool de conexiones con Neon (con SSL requerido)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Prueba rápida de conexión
pool.query('SELECT NOW()', (err, res) => {
    if (err) {
        console.error('❌ Error al conectar a la base de datos:', err);
    } else {
        console.log('✅ Conectado exitosamente a la base de datos de Neon en la hora:', res.rows[0].now);
    }
});

// ==========================================
// MÓDULO DE AUTENTICACIÓN (LOGIN)
// ==========================================
app.post('/api/login', async (req, res) => {
  const { correo, password } = req.body;

  try {
    const userQuery = 'SELECT * FROM usuarios WHERE correo = $1 AND activo = TRUE';
    const result = await pool.query(userQuery, [correo]);

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas o usuario inactivo.' });
    }

    const usuario = result.rows[0];

    const passwordMatch = await bcrypt.compare(password, usuario.password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ success: false, message: 'Credenciales inválidas.' });
    }

    const token = jwt.sign(
      { id: usuario.id, rol: usuario.rol, nombre: usuario.nombre_completo },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.json({
      success: true,
      message: 'Inicio de sesión exitoso',
      token,
      usuario: {
        id: usuario.id,
        nombre: usuario.nombre_completo,
        correo: usuario.correo,
        rol: usuario.rol
      }
    });

  } catch (error) {
    console.error('Error en el login:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
});

// ==========================================
// MÓDULO DE PRODUCTOS E INVENTARIO
// ==========================================
// 1. Registrar un nuevo producto (incluyendo imagen_url)
app.post('/api/productos', async (req, res) => {
  const { codigo_barras, nombre, marca, tipo, descripcion, precio_unitario, stock, stock_minimo, actualizado_por, imagen_url } = req.body;

  // Convertir actualizado_por a número entero de forma segura (evita el error de tipo integer)
  const safeActualizadoPor = !isNaN(parseInt(actualizado_por)) ? parseInt(actualizado_por, 10) : 1;

  try {
    const query = `
      INSERT INTO productos (codigo_barras, nombre, marca, tipo, descripcion, precio_unitario, stock, stock_minimo, actualizado_por, imagen_url)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *;
    `;
    const values = [
      codigo_barras || `750${Math.floor(100000000 + Math.random() * 900000000)}`, 
      nombre, 
      marca || 'Genérico', 
      tipo || 'generico', 
      descripcion || '', 
      parseFloat(precio_unitario) || 0, 
      parseInt(stock) || 10, 
      parseInt(stock_minimo) || 5, 
      safeActualizadoPor, // <- Ahora enviamos un número entero garantizado
      imagen_url || null
    ];
    
    const result = await pool.query(query, values);

    res.status(201).json({
      success: true,
      message: 'Producto e imagen registrados exitosamente',
      producto: result.rows[0]
    });
  } catch (error) {
    console.error('❌ Error detallado al registrar producto en Neon:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/productos', async (req, res) => {
  const { buscar } = req.query;

  try {
    let query = 'SELECT * FROM productos';
    let values = [];

    if (buscar) {
      query += ' WHERE nombre ILIKE $1 OR marca ILIKE $1';
      values.push(`%${buscar}%`);
    }

    query += ' ORDER BY nombre ASC';
    const result = await pool.query(query, values);

    res.json({
      success: true,
      productos: result.rows,
      data: result.rows
    });
  } catch (error) {
    console.error('Error al obtener productos:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
});

// ==========================================
// MÓDULO DE VENTAS (CAJERO)
// ==========================================
app.post('/api/ventas', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { folio_venta, receta_folio, cajero_id, subtotal, iva, total, metodo_pago, productos } = req.body;
        const safeCajeroId = cajero_id ? parseInt(cajero_id, 10) : null;
        const safeMetodoPago = metodo_pago || 'efectivo';

        // 1. Registrar venta principal incluyendo metodo_pago
        const ventaQuery = `
            INSERT INTO ventas (folio_venta, receta_folio, cajero_id, subtotal, iva, total, metodo_pago, creado_en)
            VALUES ($1, $2, $3, $4, $5, $6, $7, NOW() AT TIME ZONE 'America/Mexico_City') RETURNING id;
        `;
        const ventaRes = await client.query(ventaQuery, [
            folio_venta, 
            receta_folio || null, 
            safeCajeroId, 
            parseFloat(subtotal), 
            parseFloat(iva), 
            parseFloat(total),
            safeMetodoPago
        ]);
        
        const ventaId = ventaRes.rows[0].id;

        // 2. Insertar detalles y descontar stock
        for (let item of productos) {
            const cantidad = parseInt(item.cantidad, 10);
            const precioUnitario = parseFloat(item.precio);
            const subtotalLinea = cantidad * precioUnitario;

            await client.query(`
                INSERT INTO detalle_ventas (venta_id, producto_id, cantidad, precio_unitario, subtotal_linea)
                VALUES ($1, $2, $3, $4, $5)
            `, [ventaId, parseInt(item.producto_id, 10), cantidad, precioUnitario, subtotalLinea]);

            await client.query(`
                UPDATE productos SET stock = stock - $1 WHERE id = $2
            `, [cantidad, parseInt(item.producto_id, 10)]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: 'Venta procesada con éxito' });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error("Error crítico al registrar la venta:", err);
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/ventas', async (req, res) => {
  try {
    const query = 'SELECT * FROM ventas ORDER BY creado_en DESC';
    const result = await pool.query(query);
    res.json({ success: true, ventas: result.rows });
  } catch (error) {
    console.error('Error al obtener ventas:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
});

app.get('/api/ventas/:id/detalles', async (req, res) => {
    try {
        const ventaId = req.params.id;
        const query = `
            SELECT dv.*, p.nombre as nombre_producto 
            FROM detalle_ventas dv
            JOIN productos p ON dv.producto_id = p.id
            WHERE dv.venta_id = $1;
        `;
        const result = await pool.query(query, [ventaId]);
        res.json({ success: true, detalles: result.rows });
    } catch (err) {
        console.error("Error al obtener detalles de venta:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// MÓDULO DE PACIENTES Y CLÍNICA (DOCTOR)
// ==========================================

// 1. Registrar un nuevo paciente
app.post('/api/pacientes', async (req, res) => {
    try {
        const { nombre_completo, fecha_nacimiento, edad, religion, estado_civil, escolaridad, ocupacion, talla, peso, signos_vitales } = req.body;
        const idUnico = `PAC-${Math.floor(100000 + Math.random() * 900000)}`;

        const query = `
            INSERT INTO pacientes (id_unico_paciente, nombre_completo, fecha_nacimiento, edad, religion, estado_civil, escolaridad, ocupacion, talla, peso, signos_vitales)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *;
        `;
        const values = [idUnico, nombre_completo, fecha_nacimiento, edad, religion, estado_civil, escolaridad, ocupacion, talla, peso, signos_vitales];
        
        const result = await pool.query(query, values);
        res.json({ success: true, paciente: result.rows[0] });
    } catch (err) {
        console.error("Error al registrar paciente:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 2. Listar todos los pacientes
app.get('/api/pacientes', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pacientes ORDER BY creado_en DESC');
    res.json({ success: true, pacientes: result.rows });
  } catch (error) {
    console.error('Error al obtener pacientes:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor.' });
  }
});

// 3. Obtener el historial clínico
app.get('/api/historia-clinica', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM historias_clinicas ORDER BY creado_en DESC');
        res.json({ success: true, historias: result.rows });
    } catch (err) {
        console.error("Error al obtener historia clínica:", err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// 4. Guardar Historia Clínica Completa (Primera vez / Subsecuente)
app.post('/api/historia-clinica', async (req, res) => {
  const { 
    paciente_id, 
    doctor_id, 
    ficha_identificacion, 
    antecedentes_heredo_familiares, 
    antecedentes_personales_no_patologicos, 
    antecedentes_personales_patologicos, 
    padecimiento_actual, 
    exploracion_fisica, 
    analisis_laboratorios, 
    diagnostico, 
    plan_pronostico 
  } = req.body;

  try {
    const query = `
      INSERT INTO historias_clinicas (
        paciente_id, doctor_id, ficha_identificacion, 
        antecedentes_heredo_familiares, antecedentes_personales_no_patologicos, 
        antecedentes_personales_patologicos, padecimiento_actual, 
        exploracion_fisica, analisis_laboratorios, diagnostico, plan_pronostico
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *;
    `;
    
    const values = [
      paciente_id, doctor_id, ficha_identificacion, 
      antecedentes_heredo_familiares, antecedentes_personales_no_patologicos, 
      antecedentes_personales_patologicos, padecimiento_actual, 
      exploracion_fisica, analisis_laboratorios, diagnostico, plan_pronostico
    ];
    
    const result = await pool.query(query, values);

    res.status(201).json({
      success: true,
      message: 'Historia clínica guardada con éxito',
      historia: result.rows[0]
    });
  } catch (error) {
    console.error('Error al guardar historia clínica:', error);
    res.status(500).json({ success: false, message: 'Error interno del servidor al guardar historia clínica.' });
  }
});

// ==========================================
// ACTUALIZAR PRODUCTO (PRECIO Y STOCK MANUAL) - v0.0.2
// ==========================================
app.put('/api/productos/:id', async (req, res) => {
  const { id } = req.params;
  const { precio_unitario, stock, stock_minimo, actualizado_por } = req.body;
  const safeActualizadoPor = !isNaN(parseInt(actualizado_por)) ? parseInt(actualizado_por, 10) : 1;

  try {
    const query = `
      UPDATE productos 
      SET precio_unitario = $1, stock = $2, stock_minimo = $3, actualizado_por = $4
      WHERE id = $5
      RETURNING *;
    `;
    const values = [
      parseFloat(precio_unitario),
      parseInt(stock, 10),
      parseInt(stock_minimo, 10) || 5,
      safeActualizadoPor,
      parseInt(id, 10)
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Producto no encontrado.' });
    }

    res.json({
      success: true,
      message: 'Producto actualizado correctamente',
      producto: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar producto:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==========================================
// ACTUALIZAR HISTORIA CLÍNICA - v0.0.2
// ==========================================
app.put('/api/historia-clinica/:id', async (req, res) => {
  const { id } = req.params;
  const { 
    antecedentes_heredo_familiares,
    antecedentes_personales_no_patologicos,
    antecedentes_personales_patologicos,
    padecimiento_actual,
    exploracion_fisica,
    analisis_laboratorios,
    diagnostico,
    plan_pronostico
  } = req.body;

  try {
    const query = `
      UPDATE historias_clinicas 
      SET antecedentes_heredo_familiares = $1,
          antecedentes_personales_no_patologicos = $2,
          antecedentes_personales_patologicos = $3,
          padecimiento_actual = $4,
          exploracion_fisica = $5,
          analisis_laboratorios = $6,
          diagnostico = $7,
          plan_pronostico = $8
      WHERE id = $9
      RETURNING *;
    `;
    const values = [
      antecedentes_heredo_familiares || '',
      antecedentes_personales_no_patologicos || '',
      antecedentes_personales_patologicos || '',
      padecimiento_actual || '',
      exploracion_fisica || '',
      analisis_laboratorios || '',
      diagnostico || '',
      plan_pronostico || '',
      parseInt(id, 10)
    ];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Historia clínica no encontrada.' });
    }

    res.json({
      success: true,
      message: 'Historia clínica actualizada correctamente',
      historia: result.rows[0]
    });
  } catch (error) {
    console.error('Error al actualizar historia clínica:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo exitosamente en el puerto ${PORT}`);
});