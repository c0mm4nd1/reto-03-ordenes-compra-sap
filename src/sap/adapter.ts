import type { OrdenCompra } from "../types.js";

/**
 * Contrato del adaptador SAP (sección 7.4 del PRD).
 *
 * La idea central: las herramientas del agente NO saben si detrás hay un SAP
 * real o una simulación con archivos. En producción se implementaría este
 * mismo contrato contra OData (API_PURCHASEORDER_PROCESS_SRV) o RFC/BAPI
 * (BAPI_PO_CREATE1). Ver diseño en SOLUCION.md, sección 7.5.
 *
 * Seguridad (OWASP LLM06: agencia excesiva): el adaptador solo expone
 * operaciones de lectura y creación determinista. No hay borrado, no hay
 * ejecución de código, no hay acceso a red arbitrario.
 */
export interface SapAdapter {
  /** Consulta un proveedor por NIT. Devuelve null si no existe. */
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>;

  /** Crea la orden y devuelve su número asignado y fecha. */
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>;

  /** Búsqueda por referencia externa: es la base de la idempotencia. */
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>;
}
