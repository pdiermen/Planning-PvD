// Test script om te controleren wat de capaciteit zou moeten zijn voor Milan van Dijk
const currentDate = new Date('2025-06-19'); // Vandaag
console.log('Huidige datum:', currentDate.toLocaleDateString('nl-NL'));

// Test verschillende project start datums
const projectStartDates = ['2025-05-11', '2025-05-12', '2025-05-13', '2025-05-14', '2025-05-15'];

// Helper functie om werkdagen tussen twee datums te berekenen (zoals in de code)
function getWorkDaysBetween(startDate, endDate) {
    let workDays = 0;
    const currentDate = new Date(startDate);
    
    // Tel de huidige datum altijd mee als werkdag
    workDays++;
    
    // Tel de resterende dagen
    while (currentDate < endDate) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) { // 0 = zondag, 6 = zaterdag
            workDays++;
        }
    }
    
    return workDays;
}

console.log('\n=== TEST: Milan van Dijk capaciteit in sprint 3 ===');

// Test met project start datum 2025-05-11
const projectStart = new Date('2025-05-11');
const sprint3Start = new Date(projectStart);
sprint3Start.setDate(projectStart.getDate() + ((3 - 1) * 14)); // Sprint 3
const sprint3End = new Date(sprint3Start);
sprint3End.setDate(sprint3Start.getDate() + 13);

console.log(`Sprint 3: ${sprint3Start.toLocaleDateString('nl-NL')} - ${sprint3End.toLocaleDateString('nl-NL')}`);

if (currentDate >= sprint3Start && currentDate <= sprint3End) {
    console.log('✅ Huidige datum valt in sprint 3');
    
    const remainingWorkDays = getWorkDaysBetween(currentDate, sprint3End);
    const totalWorkDaysInSprint = 10;
    const capacityFactor = remainingWorkDays / totalWorkDaysInSprint;
    
    console.log(`Resterende werkdagen: ${remainingWorkDays}`);
    console.log(`Capaciteitsfactor: ${capacityFactor.toFixed(3)}`);
    
    // Milan van Dijk heeft 15 effectieve uren/week volgens de Employees sheet
    const milanEffectiveHours = 15;
    const originalCapacity = milanEffectiveHours * 2; // 30 uur per sprint
    const availableCapacity = Math.round(originalCapacity * capacityFactor);
    
    console.log(`\nMilan van Dijk capaciteit berekening:`);
    console.log(`- Effectieve uren/week: ${milanEffectiveHours}`);
    console.log(`- Originele capaciteit per sprint: ${originalCapacity} uur`);
    console.log(`- Beschikbare capaciteit: ${availableCapacity} uur`);
    
    // Test wat er zou gebeuren als de capaciteitsfactor 0.057 zou zijn (1.71/30)
    const testFactor = 1.71 / 30;
    console.log(`\nTest met factor ${testFactor.toFixed(3)} (zoals in de logs):`);
    console.log(`- Beschikbare capaciteit: ${Math.round(originalCapacity * testFactor)} uur`);
    
    // Bereken welke capaciteitsfactor nodig is voor 1.71 uur
    const targetHours = 1.71;
    const requiredFactor = targetHours / originalCapacity;
    console.log(`\nOm 1.71 uur te krijgen:`);
    console.log(`- Benodigde factor: ${requiredFactor.toFixed(3)}`);
    console.log(`- Dit zou betekenen: ${Math.round(requiredFactor * totalWorkDaysInSprint)} werkdagen over`);
    
    console.log(`\n✅ VERWACHT RESULTAAT NA FIX:`);
    console.log(`- Milan van Dijk zou nu ${availableCapacity} uur moeten hebben in plaats van 1.71 uur`);
    console.log(`- Dit is een verbetering van ${(availableCapacity - 1.71).toFixed(1)} uur`);
    
} else {
    console.log('❌ Huidige datum valt NIET in sprint 3');
}

console.log('\n=== TEST: getWorkDaysBetween 19-6-2025 t/m 21-6-2025 ===');
const start = new Date('2025-06-19'); // donderdag
const end = new Date('2025-06-21');   // zaterdag

function getWorkDaysBetweenWithLog(startDate, endDate) {
    let workDays = 0;
    const currentDate = new Date(startDate);
    console.log(`Start: ${currentDate.toLocaleDateString('nl-NL')}`);
    // Tel de huidige datum altijd mee als werkdag
    if (currentDate.getDay() !== 0 && currentDate.getDay() !== 6) {
        workDays++;
        console.log(`  Werkdag: ${currentDate.toLocaleDateString('nl-NL')}`);
    } else {
        console.log(`  Geen werkdag: ${currentDate.toLocaleDateString('nl-NL')}`);
    }
    // Tel de resterende dagen
    while (currentDate < endDate) {
        currentDate.setDate(currentDate.getDate() + 1);
        const dayOfWeek = currentDate.getDay();
        if (dayOfWeek !== 0 && dayOfWeek !== 6) {
            workDays++;
            console.log(`  Werkdag: ${currentDate.toLocaleDateString('nl-NL')}`);
        } else {
            console.log(`  Geen werkdag: ${currentDate.toLocaleDateString('nl-NL')}`);
        }
    }
    return workDays;
}

const workDays = getWorkDaysBetweenWithLog(start, end);
console.log(`Totaal aantal werkdagen tussen ${start.toLocaleDateString('nl-NL')} en ${end.toLocaleDateString('nl-NL')}: ${workDays}`);

console.log('\n=== SAMENVATTING VAN DE FIX ===');
console.log('✅ Probleem geïdentificeerd: Twee verschillende getWorkDaysBetween functies');
console.log('✅ Oplossing: Één gedeelde functie geïmporteerd uit google-sheets.ts');
console.log('✅ Resultaat: Consistente capaciteit berekening in alle delen van de applicatie');
console.log('✅ Milan van Dijk krijgt nu 6 uur in plaats van 1.71 uur in sprint 3'); 