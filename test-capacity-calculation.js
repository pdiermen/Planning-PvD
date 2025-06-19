// Test script om de capaciteit berekening te controleren
import { getWorkDaysBetween } from './dist/google-sheets.js';

console.log('=== TEST: Capaciteit berekening na fix ===');

// Test de getWorkDaysBetween functie
const currentDate = new Date('2025-06-19');
const sprint3End = new Date('2025-06-21');

console.log(`Huidige datum: ${currentDate.toLocaleDateString('nl-NL')}`);
console.log(`Sprint 3 eind: ${sprint3End.toLocaleDateString('nl-NL')}`);

const workDays = getWorkDaysBetween(currentDate, sprint3End);
console.log(`Werkdagen tussen ${currentDate.toLocaleDateString('nl-NL')} en ${sprint3End.toLocaleDateString('nl-NL')}: ${workDays}`);

// Test capaciteit berekening voor Milan van Dijk
const totalWorkDaysInSprint = 10;
const capacityFactor = workDays / totalWorkDaysInSprint;
const milanEffectiveHours = 15;
const originalCapacity = milanEffectiveHours * 2;
const availableCapacity = Math.round(originalCapacity * capacityFactor);

console.log(`\nMilan van Dijk capaciteit berekening:`);
console.log(`- Effectieve uren/week: ${milanEffectiveHours}`);
console.log(`- Originele capaciteit per sprint: ${originalCapacity} uur`);
console.log(`- Capaciteitsfactor: ${capacityFactor.toFixed(3)}`);
console.log(`- Beschikbare capaciteit: ${availableCapacity} uur`);

console.log(`\n✅ VERWACHT RESULTAAT:`);
console.log(`- Werkdagen: ${workDays} (moet 2 zijn)`);
console.log(`- Capaciteitsfactor: ${capacityFactor.toFixed(3)} (moet 0.200 zijn)`);
console.log(`- Beschikbare capaciteit: ${availableCapacity} uur (moet 6 zijn)`);

if (workDays === 2 && Math.abs(capacityFactor - 0.2) < 0.001 && availableCapacity === 6) {
    console.log(`\n🎉 SUCCES: De capaciteit berekening werkt correct!`);
} else {
    console.log(`\n❌ FOUT: De capaciteit berekening werkt nog niet correct.`);
    console.log(`- Werkdagen: ${workDays} (verwacht: 2)`);
    console.log(`- Capaciteitsfactor: ${capacityFactor} (verwacht: 0.2)`);
    console.log(`- Beschikbare capaciteit: ${availableCapacity} (verwacht: 6)`);
} 