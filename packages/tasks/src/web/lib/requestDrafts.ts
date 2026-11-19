import { useEffect, useState } from "react";
import { type Request } from "../../shared/types.ts";
import { sameTags } from "../../shared/tags.ts";
import { draftOf, sameBody, syncFieldDraft } from "./draft.ts";

/** 要望のタイトル・タグ・本文の下書き（要望の画面） */

export type RequestDrafts = ReturnType<typeof useRequestDrafts>;

/**
 * 要望のタイトル・タグ・本文の下書き。3つは同じファイル（同じ rev）なので、取り直したときは項目ごとに比べ、
 * ほかの項目の変更（自分の保存・Preflight のステータスなど）では競合にしない。項目が外で変わったときだけ知らせる
 */
export function useRequestDrafts(request: Request) {
  const [titleD, setTitleD] = useState(() => draftOf(request.title, request.rev));
  const [tagsD, setTagsD] = useState(() => draftOf<string[]>(request.tags, request.rev));
  const [bodyD, setBodyD] = useState(() => draftOf(request.body, request.rev));
  // 値に何が入っていても区切りにならない文字でつなぐ（配列は取り直すたびに別物になるので、中身で比べる）
  const tagsKey = request.tags.join("\u0000");
  useEffect(() => {
    setTitleD((d) => syncFieldDraft(d, request.title, request.rev));
    setTagsD((d) => syncFieldDraft(d, request.tags, request.rev, sameTags));
    setBodyD((d) => syncFieldDraft(d, request.body, request.rev, sameBody));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request.title, tagsKey, request.body, request.rev]);
  return { titleD, setTitleD, tagsD, setTagsD, bodyD, setBodyD };
}

