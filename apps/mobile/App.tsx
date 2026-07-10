// Password Vault — mobile shell. All crypto/vault logic comes from @pw/core (injected
// libsodium via src/sodiumProvider.ts). Locked/onboarding states render outside the
// navigator so locking always drops straight to the unlock screen.
//
// NOTE: this app requires a DEV BUILD (expo-dev-client / `npx expo run:ios|android`) —
// react-native-libsodium ships native code and does not run in Expo Go.
import React, { useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { StatusBar } from "expo-status-bar";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";
import { VaultProvider, useVault } from "./src/vault/VaultContext";
import { OnboardingScreen } from "./src/screens/OnboardingScreen";
import { UnlockScreen } from "./src/screens/UnlockScreen";
import { RecoverScreen } from "./src/screens/RecoverScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { ItemsScreen } from "./src/screens/ItemsScreen";
import { ItemDetailScreen } from "./src/screens/ItemDetailScreen";
import { ItemEditScreen } from "./src/screens/ItemEditScreen";
import { GeneratorScreen } from "./src/screens/GeneratorScreen";
import { BackupScreen } from "./src/screens/BackupScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { ActivityScreen } from "./src/screens/ActivityScreen";
import { RestoreVaultView } from "./src/vault/RestoreVaultView";
import { colors } from "./src/theme";
import type { RootStackParamList } from "./src/nav";

const Stack = createNativeStackNavigator<RootStackParamList>();

function Root() {
  const { status, refresh } = useVault();
  const [lockedView, setLockedView] = useState<"unlock" | "recover" | "restore">("unlock");

  if (status === "loading") {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg, justifyContent: "center" }}>
        <ActivityIndicator color={colors.primary} size="large" />
      </View>
    );
  }

  if (status === "none") {
    return lockedView === "restore" ? (
      <RestoreVaultView onDone={() => setLockedView("unlock")} onCancel={() => setLockedView("unlock")} />
    ) : (
      <OnboardingScreen onRestoreInstead={() => setLockedView("restore")} />
    );
  }

  if (status === "locked") {
    if (lockedView === "recover") return <RecoverScreen onCancel={() => setLockedView("unlock")} />;
    if (lockedView === "restore")
      return <RestoreVaultView onDone={() => setLockedView("unlock")} onCancel={() => setLockedView("unlock")} />;
    return <UnlockScreen onRecover={() => setLockedView("recover")} />;
  }

  return (
    <NavigationContainer
      onStateChange={refresh /* also resets the idle auto-lock timer */}
    >
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.card },
          headerTintColor: colors.text,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="Home" component={HomeScreen} options={{ title: "Password Vault" }} />
        <Stack.Screen name="Items" component={ItemsScreen} options={{ title: "Items" }} />
        <Stack.Screen name="ItemDetail" component={ItemDetailScreen} options={{ title: "Item" }} />
        <Stack.Screen name="ItemEdit" component={ItemEditScreen} options={{ title: "Edit" }} />
        <Stack.Screen name="Generator" component={GeneratorScreen} options={{ title: "Generator" }} />
        <Stack.Screen name="Backup" component={BackupScreen} options={{ title: "Backup & restore" }} />
        <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: "Settings" }} />
        <Stack.Screen name="Activity" component={ActivityScreen} options={{ title: "Activity history" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <VaultProvider>
      <StatusBar style="dark" />
      <Root />
    </VaultProvider>
  );
}
