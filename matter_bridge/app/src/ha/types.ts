export interface HassEntity {
    entity_id: string;
    state: string;
    attributes: Record<string, any>;
    last_changed?: string;
    last_updated?: string;
}

export interface HassEntityRegistryEntry {
    entity_id: string;
    name: string | null;
    original_name?: string | null;
    device_id: string | null;
    area_id: string | null;
    labels?: string[];
    disabled_by: string | null;
    hidden_by: string | null;
    entity_category: string | null;
    platform: string;
    unique_id?: string;
}

export interface HassDeviceRegistryEntry {
    id: string;
    name: string | null;
    name_by_user: string | null;
    manufacturer: string | null;
    model: string | null;
    sw_version: string | null;
    hw_version: string | null;
    serial_number?: string | null;
    area_id: string | null;
    labels?: string[];
}

export interface HassAreaRegistryEntry {
    area_id: string;
    name: string;
}

export interface HassLabelRegistryEntry {
    label_id: string;
    name: string;
}
