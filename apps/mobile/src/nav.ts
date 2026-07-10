import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import type { ItemType } from "@pw/core";

export type CategoryKey = "all" | "banking" | "cards" | "upi" | "govids" | "notes";

export type RootStackParamList = {
  Home: undefined;
  Items: { category?: CategoryKey } | undefined;
  ItemDetail: { id: string };
  ItemEdit: { id?: string; type?: ItemType };
  Generator: undefined;
  Backup: undefined;
  Settings: undefined;
  Activity: undefined;
};

export type ScreenProps<T extends keyof RootStackParamList> = NativeStackScreenProps<
  RootStackParamList,
  T
>;
