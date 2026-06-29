import { useEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";

interface UseInlineRenameOptions {
  readonly currentTitle: string;
  readonly onCommit: (title: string) => void;
  readonly onBegin?: () => void;
}

interface UseInlineRenameResult {
  readonly renaming: boolean;
  readonly draftTitle: string;
  readonly inputRef: RefObject<HTMLInputElement | null>;
  readonly begin: () => void;
  readonly cancel: () => void;
  readonly commit: () => void;
  readonly setDraftTitle: (value: string) => void;
  readonly handleKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly handleBlur: () => void;
}

export function useInlineRename(options: UseInlineRenameOptions): UseInlineRenameResult {
  const { currentTitle, onCommit, onBegin } = options;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const committingRef = useRef(false);
  const skipBlurCommitRef = useRef(false);
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const begin = () => {
    onBegin?.();
    skipBlurCommitRef.current = false;
    setDraftTitle(currentTitle);
    setRenaming(true);
  };

  const cancel = () => {
    skipBlurCommitRef.current = true;
    setRenaming(false);
    setDraftTitle("");
  };

  const commit = () => {
    if (committingRef.current) return;
    committingRef.current = true;
    try {
      onCommit(draftTitle);
    } finally {
      committingRef.current = false;
      skipBlurCommitRef.current = true;
      setRenaming(false);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
    }
  };

  const handleBlur = () => {
    if (skipBlurCommitRef.current) {
      skipBlurCommitRef.current = false;
      return;
    }
    commit();
  };

  return { renaming, draftTitle, inputRef, begin, cancel, commit, setDraftTitle, handleKeyDown, handleBlur };
}
