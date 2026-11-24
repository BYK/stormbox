export interface MailActionPatch {
  mailAction: true;
  messageIds: number[];
  sourceFolderId?: number;
  removeFrom?: 'source' | 'other' | 'all';
  destinationFolderId?: number;
  excludeFromTags?: boolean;
  add?: string[];
  remove?: string[];
  label: string;
  subject?: string;
  failureAction: string;
  successNotice?: string;
  undoable?: false;
}

export interface MailActionRow {
  id: number;
  mutation_type: string;
  target_message_id: number | null;
  request_json: string;
  optimistic_patch_json: string;
  local_status: 'pending' | 'retry' | 'in_flight' | 'conflicted';
  error_json: string | null;
  not_before: number | null;
}

export function mailActionPatch(json: string | null | undefined): MailActionPatch | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json);
    return value?.mailAction === true && Array.isArray(value.messageIds) ? value : null;
  } catch {
    return null;
  }
}
