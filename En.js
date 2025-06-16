import React, { useState } from 'react';

// Componente interno para renderizar cada tipo de pregunta.
const FormQuestion = ({ question, answer, onAnswerChange }) => {
    const { id, label, type, options, required } = question;

    const renderInput = () => {
        switch (type) {
            case 'textarea':
                return <textarea id={id} value={answer || ''} onChange={(e) => onAnswerChange(id, e.target.value)} required={required} className="bg-main border border-subtle-border rounded-lg p-3 w-full h-32 text-white focus:outline-none focus:border-primary" />;
            case 'select':
                return (
                    <select id={id} value={answer || ''} onChange={(e) => onAnswerChange(id, e.target.value)} required={required} className="bg-main border border-subtle-border rounded-lg p-3 w-full text-white focus:outline-none focus:border-primary">
                        <option value="">Selecciona una opción...</option>
                        {options?.map((opt, index) => <option key={index} value={opt}>{opt}</option>)}
                    </select>
                );
            case 'checkbox':
                return (
                    <div className="space-y-2 mt-2">
                        {options?.map((opt, index) => (
                            <div key={index} className="flex items-center gap-2">
                                <input type="checkbox" id={`${id}-${index}`} name={id} value={opt} checked={Array.isArray(answer) ? answer.includes(opt) : false} 
                                       onChange={(e) => {
                                            const currentAnswers = Array.isArray(answer) ? answer : [];
                                            const newAnswers = e.target.checked ? [...currentAnswers, opt] : currentAnswers.filter(a => a !== opt);
                                            onAnswerChange(id, newAnswers);
                                       }}
                                       className="w-4 h-4 text-primary bg-main border-subtle-border rounded focus:ring-primary"/>
                                <label htmlFor={`${id}-${index}`}>{opt}</label>
                            </div>
                        ))}
                    </div>
                );
            default: // text
                return <input type="text" id={id} value={answer || ''} onChange={(e) => onAnswerChange(id, e.target.value)} required={required} className="bg-main border border-subtle-border rounded-lg p-3 w-full text-white focus:outline-none focus:border-primary"/>;
        }
    };
    
    return (
        <div>
            <label htmlFor={id} className="block text-secondary-text text-sm font-semibold mb-2">
                {label} {required && <span className="text-red-400">*</span>}
            </label>
            {renderInput()}
        </div>
    );
};

// --- COMPONENTE PRINCIPAL ---
const ApplicationForm = ({ forms, onSubmit }) => {
    const [selectedForm, setSelectedForm] = useState(null);
    const [answers, setAnswers] = useState({});

    const handleAnswerChange = (questionId, value) => {
        setAnswers(prev => ({ ...prev, [questionId]: value }));
    };

    const handleSubmit = (e) => {
        e.preventDefault();
        onSubmit(answers, selectedForm);
    };

    // Filtra los formularios que están actualmente abiertos
    const availableForms = forms.filter(form => {
        const now = new Date();
        const opensAt = form.opensAt ? new Date(form.opensAt) : null;
        const closesAt = form.closesAt ? new Date(form.closesAt) : null;
        if (opensAt && now < opensAt) return false; // Aún no ha abierto
        if (closesAt && now > closesAt) return false; // Ya cerró
        return true;
    });

    // Si no se ha seleccionado un formulario, muestra la lista para elegir
    if (!selectedForm) {
        return (
            <div>
                <h2 className="text-3xl font-bold text-main-text mb-8">Enviar Postulación</h2>
                {availableForms.length === 0 ? (
                    <p className="text-secondary-text">No hay formularios de postulación disponibles en este momento.</p>
                ) : (
                    <div className="space-y-4">
                        <p className="text-secondary-text">Selecciona el formulario que deseas completar:</p>
                        {availableForms.map(form => (
                            <button
                                key={form.id}
                                onClick={() => setSelectedForm(form)}
                                className="w-full text-left bg-panels p-6 rounded-lg hover:bg-primary/20 transition-colors"
                            >
                                <h3 className="text-xl font-bold text-main-text">{form.title}</h3>
                                <p className="text-sm text-secondary-text">{form.questions.length} preguntas.</p>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        );
    }

    // Si ya se seleccionó un formulario, muestra las preguntas
    return (
        <div>
            <div className="flex items-center gap-4 mb-6">
                 <button onClick={() => setSelectedForm(null)} className="p-2 rounded-md hover:bg-panels">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7"></path></svg>
                 </button>
                <h2 className="text-3xl font-bold text-main-text">{selectedForm.title}</h2>
            </div>
            <div className="bg-panels rounded-lg p-8">
                <form onSubmit={handleSubmit} className="space-y-6">
                    {selectedForm.questions.map(question => (
                        <FormQuestion key={question.id || question.label} question={question} answer={answers[question.id]} onAnswerChange={handleAnswerChange} />
                    ))}
                    <div className="pt-4">
                        <button type="submit" className="w-full py-3 px-6 rounded-lg font-bold bg-primary hover:bg-primary-hover text-white transition-colors">Enviar Postulación</button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ApplicationForm;

                    
