"use client";

import { useState, useRef, useEffect, useCallback, useId } from "react";

type TagInputProps = {
  tags: string[];
  onChange: (tags: string[]) => void;
  suggestions: string[];
  "aria-labelledby"?: string;
};

export function TagInput({
  tags,
  onChange,
  suggestions,
  "aria-labelledby": ariaLabelledBy,
}: TagInputProps) {
  const [input, setInput] = useState("");
  const [showDropdown, setShowDropdown] = useState(false);
  const [highlightIndex, setHighlightIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  // Filter suggestions: not already added, matches typed text
  const tagsLower = tags.map((t) => t.toLowerCase());
  const filtered = suggestions.filter(
    (s) =>
      !tagsLower.includes(s.toLowerCase()) &&
      s.toLowerCase().includes(input.toLowerCase().trim()),
  );

  const activeOptionId =
    showDropdown && highlightIndex >= 0 && highlightIndex < filtered.length
      ? `${listboxId}-option-${highlightIndex}`
      : undefined;

  const addTag = useCallback(
    (tag: string) => {
      const trimmed = tag.trim();
      if (
        !trimmed ||
        tags.some((t) => t.toLowerCase() === trimmed.toLowerCase())
      )
        return;
      onChange([...tags, trimmed]);
      setInput("");
      setShowDropdown(false);
      setHighlightIndex(-1);
    },
    [tags, onChange],
  );

  const removeTag = useCallback(
    (tag: string) => {
      onChange(tags.filter((t) => t !== tag));
    },
    [tags, onChange],
  );

  // Close dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setShowDropdown(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      if (highlightIndex >= 0 && highlightIndex < filtered.length) {
        addTag(filtered[highlightIndex]);
      } else if (input.trim()) {
        addTag(input);
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightIndex((i) => Math.max(i - 1, -1));
    } else if (e.key === "Escape") {
      setShowDropdown(false);
    } else if (e.key === "Backspace" && !input && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap gap-1 rounded-lg border border-slate-700 bg-slate-800 px-2 py-1.5 focus-within:border-indigo-500 focus-within:ring-1 focus-within:ring-indigo-500">
        {tags.map((tag) => (
          <span
            key={tag}
            className="inline-flex items-center gap-1 rounded-full bg-slate-700 px-2 py-0.5 text-xs text-slate-300"
          >
            {tag}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              aria-label={`Remove ${tag}`}
              className="text-slate-500 hover:text-slate-200 leading-none text-sm"
            >
              &times;
            </button>
          </span>
        ))}
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setShowDropdown(true);
            setHighlightIndex(-1);
          }}
          onFocus={() => setShowDropdown(true)}
          onBlur={() => {
            // Delay so onMouseDown on suggestions fires before dropdown hides
            setTimeout(() => setShowDropdown(false), 150);
          }}
          onKeyDown={handleKeyDown}
          placeholder={tags.length === 0 ? "Add tags…" : ""}
          aria-label={ariaLabelledBy ? undefined : "Add tag"}
          aria-labelledby={ariaLabelledBy}
          aria-expanded={showDropdown && filtered.length > 0}
          aria-controls={
            showDropdown && filtered.length > 0 ? listboxId : undefined
          }
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          className="flex-1 min-w-[80px] bg-transparent text-sm text-white placeholder-slate-500 outline-none py-0.5"
        />
      </div>

      {showDropdown && filtered.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-48 w-full overflow-y-auto rounded-lg border border-slate-700 bg-slate-800 py-1 shadow-xl"
        >
          {filtered.map((suggestion, i) => (
            <li
              key={suggestion}
              id={`${listboxId}-option-${i}`}
              role="option"
              aria-selected={i === highlightIndex}
              onMouseDown={(e) => {
                e.preventDefault();
                addTag(suggestion);
              }}
              className={`cursor-pointer px-3 py-1.5 text-sm ${
                i === highlightIndex
                  ? "bg-indigo-600 text-white"
                  : "text-slate-300 hover:bg-slate-700"
              }`}
            >
              {suggestion}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
