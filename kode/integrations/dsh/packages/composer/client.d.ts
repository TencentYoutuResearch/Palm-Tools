import type {ComponentType, ReactNode} from 'react';
/** Native ComposerAttachments item shape (conversation.input.attachments). */
export interface PortableAttachment { id: string; kind: 'image' | 'file'; file: File; previewUrl?: string }
/** Caller-owned staging. The adapter never uploads, reads or persists files. */
export interface PortableAttachmentsSpec {
 items: readonly PortableAttachment[];
 uploads?: Readonly<Record<string, {status: 'uploading' | 'ready' | 'error'; loaded?: number; total?: number}>>;
 /** False keeps the seat visible and explains why files are refused. */
 canAccept: boolean;
 unsupportedLabel?: string;
 addLabel?: string;
 accept?: string;
 limits?: {count: number; size: string};
 onAdd(files: File[]): void;
 onRemove(id: string): void;
 onRetry?(id: string): void;
}
/** Native conversation.input.activity runtime props, minus sessionId (no Session is synthesized). */
export interface PortableActivityProps {
 inputActions: Readonly<{captureInsertion(): unknown; insertText(text: string, span: unknown): boolean}>;
 locked: boolean;
 onActiveChange(active: boolean): void;
}
/** Draft/persistence/permission remains owned by the caller. Change scopeKey to remount. */
export interface PortableTextComposerProps {
 scopeKey: string;
 value: string;
 ariaLabel: string;
 placeholder?: string;
 sendLabel?: string;
 failureLabel?: string;
 /** Maximum UTF-16 text length, capped at 65536; oversized text is never silently truncated. */
 maxLength?: number;
 lengthLimitLabel?: string;
 unsupportedFilesLabel?: string;
 /** Disables editing and sending, e.g. while permission/storage is unavailable. */
 disabled?: boolean;
 readOnly?: boolean;
 /** Locks uncertain-send content but allows idempotent retry. */
 editingDisabled?: boolean;
 /** Inside the card above the editor (native InputBar accessory). */
 accessory?: ReactNode;
 /** Native hero workspace row above the card: workspace chip, host, Agent. */
 header?(seat: {WorkspaceChip: ComponentType<{buttonRef?: unknown; label?: string; menuOpen?: boolean; onClick(): void; t(key: string): string}> | null}): ReactNode;
 /** Bottom-left tools after the add button (permission/plan seats). */
 tools?: ReactNode;
 /** Native standardControls before activity and send, e.g. the model picker. */
 trailing?: ReactNode;
 attachments?: PortableAttachmentsSpec;
 /** Render the native conversation.input.attachments entry with these props. */
 renderAttachments?(props: Record<string, unknown>): ReactNode;
 /** Render the native conversation.input.activity entry (voice) with these props. */
 renderActivity?(props: PortableActivityProps): ReactNode;
 /** Send is enabled without typed text; the caller's action is explicit (e.g. open a planning Session). */
 allowEmpty?: boolean;
 /** Keep the draft editable but block send (e.g. Agent/model not yet valid). */
 sendDisabled?: boolean;
 onChange(text: string): void;
 /** Must resolve only when caller handles receipt; callback owns idempotency and authorization. */
 onSubmit(request: Readonly<{scopeKey: string; text: string; attachmentIds?: readonly string[]}>): Promise<void>;
}
export declare function PortableTextComposer(props: PortableTextComposerProps): ReactNode;
export declare const portableComposerCapabilities: Readonly<{version:1;text:true;attachments:true;voice:true;header:true;trailing:true;activity:true;allowEmpty:true;sendDisabled:true}>;

/** Inert Cordis client activation entry. Registers no services or Conversation. */
export declare function apply(): void;
