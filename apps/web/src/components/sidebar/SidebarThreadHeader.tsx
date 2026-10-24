import {
  FolderPlusIcon,
  ListTodoIcon,
  MessageCircleIcon,
  MessageCirclePlusIcon,
  SearchIcon,
  SquarePenIcon,
  XIcon,
} from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";

import { cn } from "~/lib/utils";
import type { SidebarThreadMode } from "../Sidebar.logic";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  searchFieldRef?: RefObject<HTMLDivElement | null>;
  hasProjects: boolean;
  projectScope: ReactNode;
  onNewProject: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  threadMode: SidebarThreadMode;
  onThreadModeChange: (mode: SidebarThreadMode) => void;
  onNewChat: () => void;
  newChatDisabled: boolean;
  newChatShortcutLabel: string | null | undefined;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  searchFieldRef,
  hasProjects,
  projectScope,
  onNewProject,
  onNewThread,
  threadMode,
  onThreadModeChange,
  onNewChat,
  newChatDisabled,
  newChatShortcutLabel,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const resultsVisible = isSearching && searchResultCount > 0;
  // Results shrink as the query narrows, so the active index can outrun the
  // list; pointing aria-activedescendant at a removed option strands the
  // screen reader on nothing.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? `New thread (${newThreadShortcutLabel})`
    : "New thread";
  const newChatLabel = newChatShortcutLabel ? `New chat (${newChatShortcutLabel})` : "New chat";
  const chats = threadMode === "chats";

  return (
    <div className="flex flex-col gap-1.5">
      <ToggleGroup
        aria-label="Show tasks or chats"
        className="w-full *:flex-1"
        value={[threadMode]}
        onValueChange={(next) => {
          const mode = next[0];
          if (mode === "tasks" || mode === "chats") onThreadModeChange(mode);
        }}
      >
        <Toggle value="tasks">
          <ListTodoIcon />
          Tasks
        </Toggle>
        <Toggle value="chats">
          <MessageCircleIcon />
          Chats
        </Toggle>
      </ToggleGroup>
      <div className="flex items-center gap-1">
        <div
          ref={searchFieldRef}
          className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
        >
          <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={searchInputRef}
            nativeInput
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={chats ? "Search chats" : "Search"}
            aria-label={chats ? "Search chats" : "Search threads"}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
            aria-activedescendant={
              activeResultExists
                ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                : undefined
            }
            className="min-w-0 flex-1"
          />
          {isSearching ? (
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0"
              aria-label="Clear thread search"
              onClick={() => {
                onClearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center">
          {hasProjects && !chats ? (
            <>
              {projectScope}
              <SidebarHeaderIconButton label="Add project" onClick={onNewProject}>
                <FolderPlusIcon />
              </SidebarHeaderIconButton>
            </>
          ) : null}
          {chats ? (
            <SidebarHeaderIconButton
              label="New chat"
              tooltip={newChatLabel}
              disabled={newChatDisabled}
              onClick={onNewChat}
            >
              <MessageCirclePlusIcon />
            </SidebarHeaderIconButton>
          ) : (
            <SidebarHeaderIconButton
              label="New thread"
              tooltip={
                showNewThreadInProjectHint ? (
                  <span className="flex flex-col gap-0.5">
                    <span>{newThreadLabel}</span>
                    <span className="text-muted-foreground">
                      New thread in current project: Shift+click
                      {newThreadInProjectShortcutLabel
                        ? ` (${newThreadInProjectShortcutLabel})`
                        : ""}
                    </span>
                  </span>
                ) : (
                  newThreadLabel
                )
              }
              disabled={newThreadDisabled}
              onClick={onNewThread}
            >
              <SquarePenIcon />
            </SidebarHeaderIconButton>
          )}
        </div>
      </div>
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
