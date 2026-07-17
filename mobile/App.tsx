/**
 * ApnaKhata — App shell
 * ---------------------
 * Minimal two-tab shell over the shipped screens (Dashboard, Scan & Bill).
 * Swap for react-navigation once more screens land; this keeps the preview
 * dependency-light.
 */

import React, { useState } from 'react';
import { Pressable, SafeAreaView, Text, View } from 'react-native';

import DashboardScreen from './src/screens/DashboardScreen';
import ScanScreen from './src/screens/ScanScreen';

type Tab = 'DASHBOARD' | 'SCAN';

const TABS: { key: Tab; label: string }[] = [
  { key: 'DASHBOARD', label: 'DASHBOARD' },
  { key: 'SCAN', label: 'SCAN & BILL' },
];

const App: React.FC = () => {
  const [tab, setTab] = useState<Tab>('DASHBOARD');

  return (
    <SafeAreaView className="flex-1 bg-[#0B0C10]">
      <View className="flex-1">{tab === 'DASHBOARD' ? <DashboardScreen /> : <ScanScreen />}</View>

      <View className="flex-row border-t border-[#C5A05922] bg-[#0B0C10] pb-2">
        {TABS.map(({ key, label }) => (
          <Pressable
            key={key}
            className="flex-1 items-center py-3"
            onPress={() => setTab(key)}
            accessibilityRole="button"
            accessibilityLabel={`Switch to ${label}`}
          >
            <View
              className={`h-0.5 w-8 rounded-full ${tab === key ? 'bg-[#C5A059]' : 'bg-transparent'}`}
            />
            <Text
              className={`mt-2 text-[10px] font-semibold tracking-[2px] ${
                tab === key ? 'text-[#C5A059]' : 'text-[#C0C0C0]'
              }`}
            >
              {label}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
};

export default App;
