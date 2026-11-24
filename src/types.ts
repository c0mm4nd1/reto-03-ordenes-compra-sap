import { z } from "zod";

/**
 * Tipos y esquemas zod del dominio del reto.
 *
 * Por qué zod en todo (OWASP LLM05: manejo impropio de salidas del modelo):
 * cualquier dato que venga del LLM, del disco o de la API HTTP se valida
 * contra estos esquemas antes de usarse. Si no cumple, se rechaza con error
 * legible y nunca llega a la lógica de negocio.
 */

// ---------- Fixtures (entrada) ----------

export const CorreoSchema = z.object({
  id: z.string(),
  de: z.string(),
  para: z.string(),
  asunto: z.string(),
  fecha: z.string(),
  cuerpo: z.string(),
  adjuntos: z.array(z.string()),
});

export const SolicitudSchema = z.object({
  solicitud_id: z.string(),
  solicitante: z.string(),
  proveedor_nombre: z.string(),
  proveedor_nit: z.string().optional(),
  descripcion: z.string(),
  centro_costo: z.string(),
  subarea: z.string(),
  cantidad: z.number().positive(),
  valor_unitario: z.number().nonnegative(),
  valor_total: z.number().nonnegative(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const AprobacionSchema = z.object({
  de: z.string(),
  para: z.string().optional(),
  fecha: z.string(),
  asunto: z.string(),
  cuerpo: z.string(),
});

export type Correo = z.infer<typeof CorreoSchema>;
export type Solicitud = z.infer<typeof SolicitudSchema>;
export type Aprobacion = z.infer<typeof AprobacionSchema>;

/** Cotización parseada desde cotizacion.txt (extracción determinista). */
export const CotizacionSchema = z.object({
  numero: z.string(),
  fecha: z.string().nullable(),
  proveedor: z.string(),
  nit: z.string().nullable(),
  total: z.number(),
  moneda: z.string(),
  validez_hasta: z.string().nullable(),
  texto: z.string(),
});

/** Factura parseada desde factura.txt (solo casos retroactivos). */
export const FacturaSchema = z.object({
  numero: z.string(),
  fecha: z.string(),
  total: z.number(),
});

export type Cotizacion = z.infer<typeof CotizacionSchema>;
export type Factura = z.infer<typeof FacturaSchema>;

/** Paquete normalizado (sección 7.2 del PRD). */
export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string };
  solicitud: Solicitud;
  cotizacion: Cotizacion | null;
  aprobacion: (Aprobacion & { aprobado: boolean }) | null;
  factura: Factura | null;
  adjuntos_faltantes: string[];
};

// ---------- Maestros de referencia ----------

export const ProveedorSchema = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
});

export const CentroCostoSchema = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(
    z.object({ email: z.string(), nombre: z.string(), tope: z.number().nonnegative() })
  ),
});

export const IndicadorIvaSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  tasa: z.number(),
});

export const CondicionPagoSchema = z.object({
  codigo: z.string(),
  descripcion: z.string(),
  dias: z.number(),
});

export type Proveedor = z.infer<typeof ProveedorSchema>;
export type CentroCosto = z.infer<typeof CentroCostoSchema>;
export type IndicadorIva = z.infer<typeof IndicadorIvaSchema>;
export type CondicionPago = z.infer<typeof CondicionPagoSchema>;
export type Maestros = {
  proveedores: Proveedor[];
  centrosCosto: CentroCosto[];
  indicadoresIva: IndicadorIva[];
  condicionesPago: CondicionPago[];
};

// ---------- Validación (salida de oc_validar) ----------

export type Hallazgo = {
  codigo: string; // RC1..RC10
  tipo: "bloqueo" | "confirmacion" | "info";
  detalle: string;
};

export type Validacion = {
  apta: boolean;
  bloqueos: Hallazgo[];
  confirmaciones: Hallazgo[];
  derivados: Record<string, { valor: string; fuente: string }>;
  retroactiva: boolean;
};

// ---------- Payload de la OC (sección 7.4 del PRD) ----------

export const OrdenCompraSchema = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({
    codigo_sap: z.string(),
    nit: z.string(),
    nombre: z.string(),
  }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string(),
  aprobador: z.object({
    email: z.string(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string(),
  }),
  posiciones: z.array(
    z.object({
      numero: z.number().int().positive(),
      descripcion: z.string().max(40), // límite de texto breve de SAP
      cantidad: z.number().positive(),
      unidad: z.enum(["UN", "H", "MES"]),
      precio_unitario: z.number().nonnegative(),
      centro_costo: z.string(),
      subarea: z.string(),
      indicador_iva: z.string(),
    })
  ),
  excepciones: z.array(
    z.object({
      codigo: z.string(),
      detalle: z.string(),
      confirmado_por: z.string().nullable(),
    })
  ),
});

export type OrdenCompra = z.infer<typeof OrdenCompraSchema>;

/** Resultado estándar de toda herramienta: nunca se lanza excepción (HU-6). */
export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };
