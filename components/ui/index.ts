// `components/ui/` never imports `maplibre-gl`, a source module or the
// database: only the pure `@/lib` modules, so a client component using a
// primitive does not pull the Postgres driver into the browser bundle.

export { Badge, badgeVariants, type BadgeProps } from "./badge";
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardAction,
  CardDescription,
  CardContent,
} from "./card";
export { Button, buttonVariants, type ButtonProps } from "./button";
export { Input } from "./input";
export { Textarea } from "./textarea";
export { Label } from "./label";
export { Separator } from "./separator";
export {
  Field,
  FieldLabel,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldContent,
  FieldTitle,
} from "./field";
export {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupText,
  InputGroupInput,
  InputGroupTextarea,
} from "./input-group";

export { Loot, type LootProps } from "./Loot";
export { RollingAmount, type RollingAmountProps } from "./RollingAmount";
export { Gauge, type GaugeProps } from "./Gauge";

export {
  Difficulty,
  type DifficultyProps,
  type BandKey,
  type ResistanceBand,
  RESISTANCE_BANDS,
  resistanceBand,
  resistanceFromOdds,
  roundTo5,
} from "./Difficulty";

export { Fact, type FactProps } from "./Fact";
export {
  Source,
  Sources,
  SOURCES,
  SOURCE_ORDER,
  type SourceKey,
  type SourceEntry,
  type SourceProps,
  type SourcesProps,
} from "./Source";
export { Hold, type HoldProps } from "./Hold";
export { Stamp, type StampProps } from "./Stamp";
export { Spinner, type SpinnerProps } from "./Spinner";
export { ConfirmDialog, type ConfirmDialogProps } from "./ConfirmDialog";

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "./dropdown-menu";

export { ThemeToggle, ThemeIcon, useTheme } from "./Toggles";
// the keys come from `./theme`, which carries no directive: read from
// `./Toggles`, a server component would get a client reference, not the string.
export {
  THEME_STORAGE_KEY,
  DEFAULT_THEME,
  THEME_SCRIPT,
  type Theme,
} from "./theme";

export { cx, type StyleVars } from "./style";
export { percent } from "./percent";
