/** 検索パラメータの値。空や文字列以外は無いものとして扱う */
export const optionalString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);
